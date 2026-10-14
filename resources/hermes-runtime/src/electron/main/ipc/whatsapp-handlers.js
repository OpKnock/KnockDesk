const { app, ipcMain } = require('electron');
const { exec } = require('child_process');
const { isWindows, isMac, macOpenApplication } = require('../../services/platform-utils');

function loadRobotModule() {
  return require('@jitsi/robotjs');
}

function registerWhatsAppHandlers() {

  ipcMain.handle('send-whatsapp-keyboard', async (_event, args) => {
    try {
      const name = String(args?.name || '').trim();
      // Collapse newlines into spaces so a multi-line message can never trigger an
      // early Enter that sends it half-typed. This is a quick ONE-shot sender.
      const message = String(args?.message || '').replace(/[\r\n]+/g, ' ').trim();

      if (!name || !message) {
        console.error('[WhatsApp Robot] Missing name or message:', { name, message });
        return { success: false, error: 'Contact name and message are required' };
      }

      // ═══════════════════════════════════════════════════════════════════
      //  macOS path — AppleScript via osascript (pure keyboard simulation)
      //  WhatsApp for Mac DOES accept keyboard navigation through search
      //  results: after typing the contact name, pressing the Down arrow
      //  twice highlights the top result, and Enter opens it. This mirrors
      //  the Windows keyboard-only flow and avoids brittle window-relative
      //  mouse coordinates that break when the window is moved or resized.
      //
      //  The AppleScript below:
      //    1. Activates WhatsApp
      //    2. Opens search (Cmd+F), clears it, types the contact name
      //    3. Presses Down arrow twice to select the top search result
      //    4. Presses Enter to open the chat
      //    5. Types the message and presses Enter to send
      // ═══════════════════════════════════════════════════════════════════
      if (isMac) {
        console.log('[WhatsApp Robot macOS] Using AppleScript approach for:', name);

        // Escape single quotes in name and message for AppleScript string safety
        const escapedName = name.replace(/'/g, "'\\''");
        const escapedMessage = message.replace(/'/g, "'\\''");

        const appleScript = `
tell application "WhatsApp" to activate
delay 3

tell application "System Events"
  tell process "WhatsApp"
    -- 1. Open search with Cmd+F
    keystroke "f" using command down
    delay 0.8

    -- 2. Clear any previous search text
    keystroke "a" using command down
    delay 0.2
    key code 51 -- Backspace/Delete
    delay 0.3

    -- 3. Type contact name
    keystroke "${escapedName}"
    delay 2.5

    -- 4. Move down into the results list and select the top chat.
    --    The first Down arrow moves focus from the search field into the
    --    results list; the second lands on the top (best) match.
    key code 125 -- Down arrow
    delay 0.5
    key code 125 -- Down arrow
    delay 0.5

    -- 5. Open the selected chat
    key code 36 -- Return
    delay 1.5

    -- 6. Type the message and send
    keystroke "${escapedMessage}"
    delay 0.8
    key code 36 -- Enter/Return to send
    delay 0.3
  end tell
end tell
`;

        // Try AppleScript first. If osascript / System Events is unavailable,
        // fall back to the same keyboard sequence driven by RobotJS.
        const { execPromise: execP } = require('../../services/platform-utils');
        try {
          await execP(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { timeout: 30000 });
          console.log('[WhatsApp Robot macOS] AppleScript completed successfully');
          return {
            success: true,
            output: 'Message sent successfully using AppleScript (macOS)',
            method: 'applescript_native',
          };
        } catch (asErr) {
          console.warn('[WhatsApp Robot macOS] AppleScript failed:', asErr.message);
          console.log('[WhatsApp Robot macOS] Falling back to RobotJS keyboard approach');

          // ── Fallback: RobotJS keyboard approach ──
          // Same pure-keyboard sequence as the AppleScript path, in case
          // osascript / System Events is unavailable.
          let robot;
          try {
            robot = loadRobotModule();
          } catch (rbErr) {
            return { success: false, error: 'Neither osascript nor RobotJS available on macOS.' };
          }

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          try { robot.setKeyboardDelay(12); } catch (_) {}

          // 1. Activate WhatsApp
          try { await execP('osascript -e \'tell application "WhatsApp" to activate\'', { timeout: 10000 }); } catch (_) {}
          await sleep(3000);

          // 2. Open search (Cmd+F), clear any previous text, type the contact name
          robot.keyTap('f', 'command');
          await sleep(800);
          robot.keyTap('a', 'command');
          await sleep(200);
          robot.keyTap('backspace');
          await sleep(300);
          robot.typeString(name);
          await sleep(2500);

          // 3. Down arrow twice selects the top result; Enter opens the chat
          robot.keyTap('down');
          await sleep(400);
          robot.keyTap('down');
          await sleep(400);
          robot.keyTap('enter');
          await sleep(1500);

          // 4. Type message and send
          robot.typeString(message);
          await sleep(800);
          robot.keyTap('enter');
          await sleep(300);

          return {
            success: true,
            output: 'Message sent successfully using RobotJS keyboard fallback (macOS)',
            method: 'robotjs_keyboard_mac',
          };
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      //  Windows path — original RobotJS keyboard-only approach
      //  (unchanged — this has always worked reliably on Windows)
      // ═══════════════════════════════════════════════════════════════════
      let robot;
      try {
        robot = loadRobotModule();
      } catch (error) {
        console.error('[WhatsApp Robot] RobotJS not available:', error.message);
        return {
          success: false,
          error: 'RobotJS module not installed. Run: npm install robotjs',
        };
      }

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try { robot.setKeyboardDelay(12); } catch (_) {}

      // 1. Bring WhatsApp Desktop to the foreground.
      exec('start whatsapp:', (error) => {
        if (error) console.warn('[WhatsApp Robot] Could not open via protocol:', error.message);
      });

      // 2. Give it a generous cold-start window.
      await sleep(7000);

      // 3. Open chat search (Ctrl+F) and clear.
      robot.keyTap('f', 'control');
      await sleep(1800);
      robot.keyTap('a', 'control');
      await sleep(200);
      robot.keyTap('backspace');
      await sleep(400);

      // 4. Type the contact name and let search results settle.
      robot.typeString(name);
      await sleep(2500);

      // 5. Open the first (best) match.
      robot.keyTap('enter');
      await sleep(1800);

      // 6. Type the message and send.
      robot.typeString(message);
      await sleep(1000);
      robot.keyTap('enter');
      await sleep(400);

      return {
        success: true,
        output: 'Message sent successfully using RobotJS',
        method: 'robotjs_native',
      };
    } catch (error) {
      console.error(error);
      return {
        success: false,
        error: error.message,
      };
    }
  });

  ipcMain.handle('keyboard-press', async (_event, { key }) => {
    const startTime = Date.now();
    try {
      let robot;
      try {
        robot = loadRobotModule();
      } catch (_error) {
        return {
          success: false,
          toolName: 'keyboard_press',
          error: 'RobotJS module not available. Keyboard control requires @jitsi/robotjs.',
          errorCode: 'MODULE_NOT_AVAILABLE',
          errorCategory: 'config',
          retryable: false,
          debugInfo: { executionTimeMs: Date.now() - startTime },
        };
      }

      const lowerKey = key.toLowerCase().trim();
      if (lowerKey.includes('+')) {
        const parts = lowerKey.split('+');
        const mainKey = parts.pop();
        const modifiers = parts;
        const modMap = { ctrl: 'control', alt: 'alt', shift: 'shift', cmd: 'command', win: 'command' };
        const robotModifiers = modifiers.map((modifier) => modMap[modifier] || modifier);

        robot.keyTap(mainKey, robotModifiers);
        console.log(`[Keyboard] Pressed: ${robotModifiers.join('+')}+${mainKey}`);
        return {
          success: true,
          toolName: 'keyboard_press',
          result: `Pressed ${key}`,
          debugInfo: { executionTimeMs: Date.now() - startTime },
        };
      }

      const keyMap = {
        enter: 'enter',
        return: 'enter',
        tab: 'tab',
        escape: 'escape',
        esc: 'escape',
        backspace: 'backspace',
        delete: 'delete',
        space: 'space',
        up: 'up',
        down: 'down',
        left: 'left',
        right: 'right',
        home: 'home',
        end: 'end',
        pageup: 'pageup',
        pagedown: 'pagedown',
        f1: 'f1',
        f2: 'f2',
        f3: 'f3',
        f4: 'f4',
        f5: 'f5',
        f6: 'f6',
        f7: 'f7',
        f8: 'f8',
        f9: 'f9',
        f10: 'f10',
        f11: 'f11',
        f12: 'f12',
        printscreen: 'printscreen',
        insert: 'insert',
        capslock: 'capslock',
        numlock: 'numlock',
        scrolllock: 'scrolllock',
      };

      const robotKey = keyMap[lowerKey] || lowerKey;
      robot.keyTap(robotKey);
      console.log(`[Keyboard] Pressed: ${robotKey}`);

      return {
        success: true,
        toolName: 'keyboard_press',
        result: `Pressed ${key}`,
        debugInfo: { executionTimeMs: Date.now() - startTime },
      };
    } catch (error) {
      console.error('[Keyboard] Press failed:', error.message);
      return {
        success: false,
        toolName: 'keyboard_press',
        error: `Key press failed: ${error.message}`,
        errorCode: 'UNKNOWN_ERROR',
        errorCategory: 'transient',
        retryable: true,
        retrySuggestion: 'Make sure the target window is focused and try again.',
        debugInfo: { executionTimeMs: Date.now() - startTime, key },
      };
    }
  });

  ipcMain.handle('keyboard-type', async (_event, { text, pressEnter }) => {
    const startTime = Date.now();
    try {
      let robot;
      try {
        robot = loadRobotModule();
      } catch (_error) {
        return {
          success: false,
          toolName: 'simulate_keyboard_press',
          error: 'RobotJS module not available. Keyboard control requires @jitsi/robotjs.',
          errorCode: 'MODULE_NOT_AVAILABLE',
          errorCategory: 'config',
          retryable: false,
          debugInfo: { executionTimeMs: Date.now() - startTime },
        };
      }

      if (text && text.length > 0) {
        robot.typeString(text);
        console.log(`[Keyboard] Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (${text.length} chars)`);
      }

      if (pressEnter) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        robot.keyTap('enter');
        console.log('[Keyboard] Pressed Enter after typing');
      }

      return {
        success: true,
        toolName: 'simulate_keyboard_press',
        result: `Typed "${text}"${pressEnter ? ' and pressed Enter' : ''}`,
        data: { charCount: text?.length || 0, enterPressed: !!pressEnter },
        debugInfo: { executionTimeMs: Date.now() - startTime },
      };
    } catch (error) {
      console.error('[Keyboard] Type failed:', error.message);
      return {
        success: false,
        toolName: 'simulate_keyboard_press',
        error: `Typing failed: ${error.message}`,
        errorCode: 'UNKNOWN_ERROR',
        errorCategory: 'transient',
        retryable: true,
        retrySuggestion: 'Make sure the target input is focused. Try clicking on it first, then type.',
        debugInfo: { executionTimeMs: Date.now() - startTime, textLength: text?.length },
      };
    }
  });
}

module.exports = { registerWhatsAppHandlers };

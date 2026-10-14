const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, Notification } = require('electron');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mime = require('mime-types');
const si = require('systeminformation');
const screenshot = require('screenshot-desktop');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

const { createPaths } = require('../shared/paths');
// Provider keys DPAPI se encrypted hain — seedha JSON.parse ab kaam nahi karta.
const keyStore = require('../../services/key-store');
const { createWindowsShellRun, toExecResult } = require('../../services/shell-runner');

function registerSystemHandlers() {
  const paths = createPaths(app);
  // Key-save fallback target (preload kdSaveKey). Plain getter, no licence gate:
  // lets Settings persist pasted API keys to userData JSON stores directly.
  ipcMain.handle('get-knockdesk-data-path', async () => app.getPath('userData'));
  const activeExecCommands = new Map();
  const killProcessTree = async (child) => {
    if (!child || !child.pid) return false;

    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.once('close', resolve);
        killer.once('error', () => resolve());
      });
      return true;
    }

    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (_error) {
      try {
        child.kill('SIGKILL');
      } catch (_innerError) {
        return false;
      }
    }

    return true;
  };

  ipcMain.handle('get-openrouter-models', async () => {
    try {
      const stored = keyStore.readKey(paths.getOpenRouterKeyPath(), ['apiKey']);
      const apiKey = stored.saved ? stored.value : process.env.OPENROUTER_API_KEY;

      if (!apiKey) return { error: 'OpenRouter Key missing' };

      const response = await axios.get('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://knockdesk.ai',
          'X-Title': 'KnockDesk',
        },
      });

      return response.data;
    } catch (error) {
      console.error('[Electron] Error fetching models:', error.message);
      return { error: error.message };
    }
  });

  ipcMain.handle('system-fs-op', async (_event, { operation, path: targetPath, content, dest }) => {
    try {
      let resolvedPath = targetPath;

      if (targetPath && (targetPath.includes('${resolvedNotesPath}') || targetPath.includes('$resolvedNotesPath'))) {
        console.warn(`[FS-OP] WARNING: AI used literal template variable "${targetPath}". Fixing...`);
        resolvedPath = targetPath.replace(/\$\{?resolvedNotesPath\}?[\\/]?/g, '');
        if (!resolvedPath || resolvedPath === targetPath) {
          resolvedPath = app.getPath('documents') + path.sep + 'KnockDesk Data';
        } else {
          resolvedPath = path.join(app.getPath('documents'), 'KnockDesk Data', resolvedPath);
        }
        console.log(`[FS-OP] Fixed literal variable: ${targetPath} -> ${resolvedPath}`);
      } else if (targetPath && !path.isAbsolute(targetPath)) {
        if (targetPath.startsWith('Documents\\') || targetPath.startsWith('Documents/')) {
          resolvedPath = path.join(app.getPath('documents'), targetPath.substring('Documents\\'.length));
        } else if (targetPath.startsWith('KnockDesk Data\\') || targetPath.startsWith('KnockDesk Data/')) {
          resolvedPath = path.join(app.getPath('documents'), targetPath);
        } else {
          resolvedPath = path.join(app.getPath('documents'), 'KnockDesk Data', targetPath);
        }
        console.log(`[FS-OP] Resolved relative path: ${targetPath} -> ${resolvedPath}`);
      }

      let resolvedDest = dest;
      if (dest) {
        if (dest.includes('${resolvedNotesPath}') || dest.includes('$resolvedNotesPath')) {
          console.warn(`[FS-OP] WARNING: AI used literal template variable in dest "${dest}". Fixing...`);
          resolvedDest = dest.replace(/\$\{?resolvedNotesPath\}?[\\/]?/g, '');
          if (!resolvedDest || resolvedDest === dest) {
            resolvedDest = app.getPath('documents') + path.sep + 'KnockDesk Data';
          } else {
            resolvedDest = path.join(app.getPath('documents'), 'KnockDesk Data', resolvedDest);
          }
          console.log(`[FS-OP] Fixed literal variable in dest: ${dest} -> ${resolvedDest}`);
        } else if (!path.isAbsolute(dest)) {
          if (dest.startsWith('Documents\\') || dest.startsWith('Documents/')) {
            resolvedDest = path.join(app.getPath('documents'), dest.substring('Documents\\'.length));
          } else if (dest.startsWith('KnockDesk Data\\') || dest.startsWith('KnockDesk Data/')) {
            resolvedDest = path.join(app.getPath('documents'), dest);
          } else {
            resolvedDest = path.join(app.getPath('documents'), 'KnockDesk Data', dest);
          }
        }
      }

      switch (operation) {
        case 'read-dir':
          return fs.readdirSync(resolvedPath);
        case 'create-dir':
          if (!fs.existsSync(resolvedPath)) fs.mkdirSync(resolvedPath, { recursive: true });
          return true;
        case 'write-file': {
          const dir = path.dirname(resolvedPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(resolvedPath, content || '');
          return true;
        }
        case 'read-file':
          return fs.readFileSync(resolvedPath, 'utf8');
        case 'delete':
          fs.rmSync(resolvedPath, { recursive: true, force: true });
          return true;
        case 'exists':
          return fs.existsSync(resolvedPath);
        case 'rename':
          fs.renameSync(resolvedPath, resolvedDest);
          return true;
        case 'copy-file':
          fs.copyFileSync(resolvedPath, resolvedDest);
          return true;
        default:
          return null;
      }
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('system-open', async (_event, { target }) => {
    const open = (await import('open')).default;
    await open(target);
    return true;
  });

  ipcMain.handle('system-exec-command', async (_event, { commandId, command, workingDir, timeout }) => {
    const effectiveTimeout = Math.max(5000, Math.min(timeout || 30000, 300000));
    const resolvedCommandId = commandId || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Windows: asli PowerShell (cmd syntax ka khud fallback) — tafseel
    // services/shell-runner.js mein. Mac ka raasta neeche bilkul pehle jaisa.
    if (process.platform === 'win32') {
      const { promise, control } = createWindowsShellRun({
        command,
        cwd: workingDir || os.homedir(),
        timeoutMs: effectiveTimeout,
      });
      activeExecCommands.set(resolvedCommandId, control);
      try {
        const result = toExecResult(await promise);
        if (!result.success) {
          console.warn(`[os_exec] ${result.shell}${result.fellBack ? ' (fallback)' : ''} exit=${result.exitCode}: ${result.error}`);
        }
        return { ...result, commandId: resolvedCommandId };
      } finally {
        activeExecCommands.delete(resolvedCommandId);
      }
    }

    return runPosixCommand({ resolvedCommandId, command, workingDir, effectiveTimeout });
  });

  const runPosixCommand = ({ resolvedCommandId, command, workingDir, effectiveTimeout }) => new Promise((resolve) => {
    const options = {
      maxBuffer: 10 * 1024 * 1024,
      timeout: effectiveTimeout,
      cwd: workingDir || os.homedir(),
      env: { ...process.env, PATH: process.env.PATH },
    };
    let settled = false;

    const child = exec(command, options, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      activeExecCommands.delete(resolvedCommandId);
      resolve({
        success: !error && !child.__knockdeskCancelled,
        commandId: resolvedCommandId,
        stdout: stdout ? stdout.toString().substring(0, 100000) : '',
        stderr: stderr ? stderr.toString().substring(0, 50000) : '',
        error: child.__knockdeskCancelled ? 'Command cancelled by user.' : error?.message,
        cancelled: Boolean(child.__knockdeskCancelled),
        exitCode: error?.code || 0,
      });
    });
    child.__knockdeskCancelled = false;
    activeExecCommands.set(resolvedCommandId, {
      cancel: async () => {
        child.__knockdeskCancelled = true;
        await killProcessTree(child);
      },
    });
  });

  ipcMain.handle('system-cancel-command', async (_event, { commandId }) => {
    const control = activeExecCommands.get(commandId);
    if (!control) {
      return { success: false, commandId, alreadyFinished: true };
    }

    await control.cancel();
    return { success: true, commandId };
  });

  ipcMain.handle('web-search', async (_event, { query }) => {
    try {
      const stored = keyStore.readKey(paths.getSecretKeyPath(), ['geminiKey', 'apiKey']);
      const apiKey = stored.saved ? stored.value : process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return { error: 'Gemini API Key not configured. Please add it in Settings.' };
      }

      const ai = new GoogleGenAI({ apiKey });
      const result = await ai.models.generateContent({
        // NOTE 2026-10-13: gemini-2.5-flash is retired (API 404: "no longer
        // available to new users"); Google directs callers to gemini-3.8-flash.
        model: 'gemini-3.8-flash',
        contents: [{
          role: 'user',
          parts: [{ text: `Search the internet and provide comprehensive, detailed results for: "${query}". Include specific facts, data, URLs/sources where possible. Format the response clearly.` }],
        }],
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      let text = '';
      try {
        if (typeof result.text === 'string') {
          text = result.text;
        } else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
          text = result.candidates[0].content.parts[0].text;
        } else if (result.response && typeof result.response.text === 'function') {
          text = result.response.text();
        } else {
          console.warn('[Web Search] Unexpected response structure:', JSON.stringify(result).slice(0, 500));
          text = JSON.stringify(result);
        }
      } catch (textErr) {
        console.error('[Web Search] Text extraction error:', textErr.message);
        text = 'Search completed but could not parse result.';
      }

      const sources = [];
      try {
        const metadata = result.candidates?.[0]?.groundingMetadata;
        if (metadata?.groundingChunks) {
          for (const chunk of metadata.groundingChunks) {
            if (chunk.web) {
              sources.push({ title: chunk.web.title || '', url: chunk.web.uri || '' });
            }
          }
        }
      } catch (_error) {
        return { success: true, content: text, sources: sources.slice(0, 10) };
      }

      return { success: true, content: text, sources: sources.slice(0, 10) };
    } catch (error) {
      console.error('[Web Search] Error:', error.message);
      return { error: `Web search failed: ${error.message}` };
    }
  });

  ipcMain.handle('search-files-content', async (_event, { query, searchPath, fileTypes }) => {
    try {
      const MAX_RESULTS = 50;
      const MAX_DEPTH = 5;
      const MAX_FILE_SIZE = 5 * 1024 * 1024;
      const results = [];
      const basePath = searchPath || path.join(app.getPath('documents'), 'KnockDesk Data');

      if (!fs.existsSync(basePath)) {
        return { success: false, error: `Path does not exist: ${basePath}` };
      }

      const defaultExts = ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.py', '.java', '.cpp', '.c', '.h', '.xml', '.yaml', '.yml', '.csv', '.log', '.ini', '.cfg', '.env', '.sh', '.bat', '.ps1'];
      const searchExts = fileTypes
        ? fileTypes.split(',').map((ext) => ext.trim().startsWith('.') ? ext.trim() : `.${ext.trim()}`)
        : defaultExts;

      const searchRegex = new RegExp(query, 'gi');

      function searchDir(dirPath, depth) {
        if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;

        let entries;
        try {
          entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch (_error) {
          return;
        }

        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) break;
          const fullPath = path.join(dirPath, entry.name);
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;

          if (entry.isDirectory()) {
            searchDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!searchExts.includes(ext)) continue;

            try {
              const stats = fs.statSync(fullPath);
              if (stats.size > MAX_FILE_SIZE) continue;

              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const matches = [];

              for (let i = 0; i < lines.length; i += 1) {
                if (searchRegex.test(lines[i])) {
                  matches.push({ line: i + 1, content: lines[i].trim().substring(0, 200) });
                  if (matches.length >= 5) break;
                }
                searchRegex.lastIndex = 0;
              }

              if (matches.length > 0) {
                results.push({ file: fullPath, fileName: entry.name, matchCount: matches.length, matches });
              }
            } catch (_error) {
              continue;
            }
          }
        }
      }

      searchDir(basePath, 0);
      return { success: true, query, searchPath: basePath, totalMatches: results.length, results };
    } catch (error) {
      return { error: `File search failed: ${error.message}` };
    }
  });

  ipcMain.handle('save-image', async (_event, { base64Data }) => {
    try {
      const filePath = path.join(app.getPath('downloads'), `knockdesk_ai_${Date.now()}.png`);
      const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (error) {
      throw error;
    }
  });

  // Visual Hub: jo hissa screen par hai us ki PNG, Downloads mein.
  //
  // Renderer sirf dabbe ki jagah (CSS px) bhejta hai; tasveer main process
  // khud leta hai. Is se renderer ko DOM → image wali koi library nahi
  // chahiye, aur canvas (globe) bhi waise hi aata hai jaisa dikhta hai.
  ipcMain.handle('visual-hub-capture', async (event, rect) => {
    try {
      const contents = event.sender;
      // capturePage DIP mein naapta hai; app ka zoom (0.65–1.25) CSS px ko badal deta hai.
      const zoom = contents.getZoomFactor() || 1;
      const area = {
        x: Math.max(0, Math.round(Number(rect?.x) * zoom)),
        y: Math.max(0, Math.round(Number(rect?.y) * zoom)),
        width: Math.round(Number(rect?.width) * zoom),
        height: Math.round(Number(rect?.height) * zoom),
      };
      if (!(area.width > 0 && area.height > 0)) return { success: false, error: 'invalid_area' };
      const image = await contents.capturePage(area);
      if (image.isEmpty()) return { success: false, error: 'empty_capture' };
      const filePath = path.join(app.getPath('downloads'), `knockdesk_visual_${Date.now()}.png`);
      fs.writeFileSync(filePath, image.toPNG());
      return { success: true, path: filePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Visual Hub: designer ke page ki POORI tasveer (upar se neeche tak), Downloads mein.
  //
  // Upar wala handler sirf wohi leta hai jo screen par nazar aa raha ho; lamba
  // page us mein adhoora aata tha. Ye page ko ek chhupi hui window mein dobara
  // laga kar poora utaarta hai (services/visual-page-capture.js — hifazat ke
  // taale bhi wahin).
  ipcMain.handle('visual-hub-capture-page', async (_event, payload) => {
    try {
      const { captureVisualPage } = require('../../services/visual-page-capture');
      const shot = await captureVisualPage({ html: payload?.html, width: payload?.width, height: payload?.height });
      const slug = String(payload?.title || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 48).toLowerCase();
      const filePath = path.join(app.getPath('downloads'), `knockdesk_visual_${slug ? `${slug}_` : ''}${Date.now()}.png`);
      await fs.promises.writeFile(filePath, shot.png);
      return { success: true, path: filePath, width: shot.width, height: shot.height };
    } catch (error) {
      console.error('[VisualHub] full-page capture failed:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('read-file-content', async (_event, { path: filePath }) => {
    try {
      console.log(`[File-Reader] Reading file: ${filePath}`);
      if (!fs.existsSync(filePath)) {
        console.error(`[File-Reader] File not found: ${filePath}`);
        return { error: 'File not found' };
      }

      const mimeType = mime.lookup(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const buffer = fs.readFileSync(filePath);
      console.log(`[File-Reader] Detected Mime: ${mimeType}, Ext: ${ext}, Size: ${buffer.length} bytes`);

      if (mimeType === 'application/pdf' || ext === '.pdf') {
        console.log('[File-Reader] Parsing PDF...');
        const data = await PDFParse(buffer);
        console.log(`[File-Reader] PDF Parsed. Content length: ${data.text?.length || 0}`);
        return { content: data.text };
      }
      if (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || ext === '.docx'
      ) {
        console.log('[File-Reader] Parsing Docx...');
        const result = await mammoth.extractRawText({ buffer });
        console.log(`[File-Reader] Docx Parsed. Content length: ${result.value?.length || 0}`);
        return { content: result.value };
      }
      if (ext === '.xlsx') {
        // Excel → CSV jaisa matn (Visual Hub "is sheet ka chart banao" ke liye).
        // exceljs bhaari hai, is liye sirf zaroorat par load hoti hai. Pehli
        // teen sheets, har ek ki pehli 400 qatarein — model ke liye kaafi.
        console.log('[File-Reader] Parsing Xlsx...');
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const cellText = (cell) => {
          const v = cell.value;
          if (v === null || v === undefined) return '';
          if (v instanceof Date) return v.toISOString().slice(0, 10);
          // Formula: natija; rich text / hyperlink: sirf matn.
          const text = typeof v === 'object' ? (v.result ?? v.text ?? (Array.isArray(v.richText) ? v.richText.map((r) => r.text).join('') : cell.text)) : v;
          const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
          return /[",]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
        };
        const sheets = [];
        for (const sheet of workbook.worksheets.slice(0, 3)) {
          const lines = [];
          sheet.eachRow({ includeEmpty: false }, (row) => {
            if (lines.length >= 400) return;
            const cells = [];
            row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell)));
            lines.push(cells.join(','));
          });
          if (lines.length) sheets.push(`# Sheet: ${sheet.name} (${sheet.rowCount} rows)\n${lines.join('\n')}`);
        }
        return { content: sheets.join('\n\n') };
      }
      if (
        mimeType.startsWith('text/')
        || mimeType === 'application/json'
        || mimeType === 'application/javascript'
        || ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.css'].includes(ext)
      ) {
        console.log('[File-Reader] Reading as Text...');
        return { content: buffer.toString('utf8') };
      }

      console.warn(`[File-Reader] Unsupported file type: ${mimeType}`);
      return { content: `[Binary/Image File: ${path.basename(filePath)}]. The content of this file is visual or binary.` };
    } catch (error) {
      console.error('[File-Reader] CRITICAL ERROR:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('pick-and-read-files', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Multimodal Files', extensions: ['jpg', 'png', 'jpeg', 'webp', 'pdf', 'doc', 'docx', 'txt', 'mp3', 'wav', 'mpeg'] },
      ],
    });

    if (canceled) return [];

    const results = [];
    for (const filePath of filePaths) {
      const stats = fs.statSync(filePath);
      if (stats.size > 50 * 1024 * 1024) continue;

      const buffer = fs.readFileSync(filePath);
      const mimeType = mime.lookup(filePath) || 'application/octet-stream';
      results.push({
        name: path.basename(filePath),
        data: buffer.toString('base64'),
        mimeType,
        path: filePath,
      });
    }
    return results;
  });

  ipcMain.handle('clipboard-read', async () => {
    try {
      return {
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toDataURL(),
      };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('clipboard-write', async (_event, { text, html, image }) => {
    try {
      if (text) clipboard.writeText(text);
      if (html) clipboard.writeHTML(html);
      if (image) {
        const img = nativeImage.createFromDataURL(image);
        clipboard.writeImage(img);
      }
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // Legacy uncompressed screenshot (Deprecated/Removed)
  // Use 'desktop-screenshot' from desktop-manager instead for AI-optimized capture.

  // 'get-screen-sources' jaan bujh kar hata diya gaya hai. Screen share
  // feature band hai, aur ye handler renderer ko poori screen/window ki
  // list dene ka wahid raasta tha. Computer-use agent ka screenshot
  // desktop-manager.js se aata hai — us par koi asar nahi.

  ipcMain.handle('send-notification', async (_event, { title, body, icon }) => {
    try {
      const notification = new Notification({
        title: title || 'KnockDesk',
        body: body || '',
        icon: icon || undefined,
      });
      notification.show();
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('http-fetch', async (_event, { url, method, headers, body }) => {
    try {
      const response = await axios({
        url,
        method: method || 'GET',
        headers: headers || {},
        data: body || undefined,
        timeout: 30000,
      });
      return {
        success: true,
        status: response.status,
        data: response.data,
        headers: response.headers,
      };
    } catch (error) {
      return {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      };
    }
  });

  ipcMain.handle('get-detailed-system-info', async () => {
    try {
      const [cpu, mem, graphics, osInfo, network, battery] = await Promise.all([
        si.cpu(),
        si.mem(),
        si.graphics(),
        si.osInfo(),
        si.networkInterfaces(),
        si.battery(),
      ]);
      return { cpu, mem, graphics, os: osInfo, network, battery };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('window-control', async (_event, { action }) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { error: 'No focused window' };

      switch (action) {
        case 'minimize':
          win.minimize();
          break;
        case 'maximize':
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          break;
        case 'close':
          win.close();
          break;
        case 'fullscreen':
          win.setFullScreen(!win.isFullScreen());
          break;
        default:
          break;
      }
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('get-processes', async () => {
    try {
      const processes = await si.processes();
      return processes.list
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 20)
        .map((proc) => ({ name: proc.name, pid: proc.pid, cpu: proc.cpu, mem: proc.mem }));
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('kill-process', async (_event, { pid }) => {
    try {
      process.kill(pid);
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // NOTE: 'send-whatsapp-keyboard' handler moved to whatsapp-handlers.js (centralized)
}

module.exports = { registerSystemHandlers };

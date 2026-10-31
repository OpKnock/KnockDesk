'use strict';

/**
 * os_exec ka Windows shell runner.
 *
 * Pehle kya tha: `child_process.exec(command)`. Windows par exec hamesha
 * cmd.exe chalata hai, jabke tool ki description aur cookbook model ko
 * PowerShell likhne ko kehti hai. Nateeja: `(Get-CimInstance Win32_Battery)
 * .EstimatedChargeRemaining` jaisi har cookbook command cmd mein fail hoti
 * thi, aur sirf tab chalti thi jab model khud `powershell -Command "..."`
 * aage laga deta — isi liye "kabhi chalta hai, kabhi nahi".
 *
 * Ab kya hai:
 *   1. Command asal PowerShell mein chalti hai (absolute path, -NoProfile,
 *      -NonInteractive taake koi prompt 30s latka na sake).
 *   2. User ki command environment variable se jaati hai, command line se
 *      nahi — koi quoting/escaping ka masla nahi, koi base64 nahi (antivirus
 *      `-EncodedCommand` ko malware pattern samajhte hain).
 *   3. Wrapper pehle PowerShell ke apne parser se command parse karta hai.
 *      Parse error (maslan cmd ka `&&`) ya pehla command PowerShell ko na
 *      mile (maslan `mklink`) to KUCH NAHI chala hota — tab wohi command
 *      cmd.exe mein chalti hai. Dobara chalane ka koi side effect nahi.
 *   4. Saaf cmd syntax (`%USERPROFILE%`, `dir /s /b`, `start ""`, `sc query`)
 *      seedha cmd.exe ko jaata hai; `powershell -Command ...` / `cmd /c ...`
 *      waisa hi chalta hai jaisa pehle chalta tha.
 *   5. Nateeja process ke EXIT par aata hai, pipes band hone par nahi. Pehle
 *      seedha khuli GUI app (notepad) pipe pakde rakhti thi aur tool 30s baad
 *      "timed out" bolta tha, halanke app khul chuki thi.
 *   6. Timeout par poora process tree band hota hai (pehle sirf cmd.exe
 *      marta tha, andar wali PowerShell chalti rehti thi).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMAND_ENV_VAR = 'KNOCKDESK_OS_EXEC_COMMAND';
const PS_EXIT_PARSE_ERROR = 97;
const PS_EXIT_NOT_FOUND = 98;
const PARSE_ERROR_MARKER = 'KNOCKDESK_PARSE_ERROR:';
const NOT_FOUND_MARKER = 'KNOCKDESK_NOT_FOUND:';

const MAX_CAPTURE_BYTES = 1024 * 1024;
// Process exit ke baad itna intezar taake pipe mein bacha output aa jaye.
// Us se zyada nahi: agar koi GUI app pipe pakde baithi hai to wo kabhi
// band nahi hogi aur hum phir se latak jaate.
const EXIT_GRACE_MS = 250;
// cmd fallback ke liye kam az kam itna waqt bacha ho, warna chalana bekaar.
const MIN_FALLBACK_BUDGET_MS = 3000;

// Ek hi line, sirf single quotes — PowerShell ki command line parsing mein
// double quotes aur newlines ke masle hote hain. User ka text is mein kabhi
// nahi jaata; wo env var se parha jaata hai aur foran mita diya jaata hai
// taake child processes ko na mile.
const POWERSHELL_WRAPPER = [
  "$ProgressPreference='SilentlyContinue'",
  'try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}',
  `$__knockdeskSrc=[Environment]::GetEnvironmentVariable('${COMMAND_ENV_VAR}')`,
  `[Environment]::SetEnvironmentVariable('${COMMAND_ENV_VAR}',$null)`,
  '$__knockdeskTok=$null',
  '$__knockdeskErr=$null',
  '$__knockdeskAst=[Management.Automation.Language.Parser]::ParseInput($__knockdeskSrc,[ref]$__knockdeskTok,[ref]$__knockdeskErr)',
  `if($__knockdeskErr.Count -gt 0){[Console]::Error.WriteLine('${PARSE_ERROR_MARKER} '+$__knockdeskErr[0].Message);exit ${PS_EXIT_PARSE_ERROR}}`,
  '$__knockdeskFns=@($__knockdeskAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|ForEach-Object{$_.Name})',
  '$__knockdeskFirst=$__knockdeskAst.Find({param($n)$n -is [Management.Automation.Language.CommandAst]},$true)',
  `if($__knockdeskFirst){$__knockdeskName=$__knockdeskFirst.GetCommandName();if($__knockdeskName -and ($__knockdeskFns -notcontains $__knockdeskName) -and -not (Get-Command -Name $__knockdeskName -ErrorAction SilentlyContinue)){[Console]::Error.WriteLine('${NOT_FOUND_MARKER} '+$__knockdeskName);exit ${PS_EXIT_NOT_FOUND}}}`,
  '$global:LASTEXITCODE=0',
  // `| Out-Default` zaroori hai: is ke baghair neeche wala `exit` PowerShell ko
  // table (Get-PSDrive, Select-Object) chhaapne se pehle band kar deta tha aur
  // output khali aata tha. Out-String/Out-Null NAHI: un mein PowerShell GUI app
  // ke band hone ka intezar karta hai (`notepad | Out-Null` wala asar).
  'try{& ([scriptblock]::Create($__knockdeskSrc)) | Out-Default}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}',
  'if($global:LASTEXITCODE -is [int] -and $global:LASTEXITCODE -ne 0){exit $global:LASTEXITCODE}',
  'exit 0',
].join(';');

// PowerShell ki pehchaan: approved verb wala cmdlet, variable, .NET call,
// ya PowerShell-only parameter. Aisi command kabhi cmd ko nahi jaati.
const PS_VERBS = 'Add|Clear|Close|Compare|Compress|Confirm|Connect|Convert|ConvertFrom|ConvertTo|Copy|Debug|Disable|Disconnect|Dismount|Enable|Enter|Exit|Expand|Export|Find|Format|Get|Grant|Group|Hide|Import|Initialize|Install|Invoke|Join|Limit|Lock|Measure|Merge|Mount|Move|New|Open|Optimize|Out|Pop|Protect|Publish|Push|Read|Receive|Register|Remove|Rename|Repair|Request|Reset|Resize|Resolve|Restart|Restore|Resume|Revoke|Save|Search|Select|Send|Set|Show|Skip|Sort|Split|Start|Step|Stop|Suspend|Switch|Sync|Tee|Test|Trace|Unblock|Undo|Uninstall|Unlock|Unprotect|Unregister|Update|Use|Wait|Watch|Where|Write|ForEach';
const POWERSHELL_MARKERS = [
  new RegExp(`(?:^|[\\s|;({=&!])(?:${PS_VERBS})-[A-Za-z]{2,}`, 'i'),
  /\$(?:[A-Za-z_?]|\{|\()/, // $var, $env:X, ${...}, $(...), $_
  /\[[A-Za-z][\w.]*\]::/, // [Math]::Round, [Environment]::...
  /\s-(?:ErrorAction|ExpandProperty|UseBasicParsing|Uri|OutFile|Recurse|Filter|Property|ComObject|ArgumentList|WindowStyle|Credential)\b/i,
];

// Sirf cmd samajhta hai (ya PowerShell mein in ka matlab kuch aur hai).
const CMD_ONLY_PATTERNS = [
  /%[A-Za-z_][\w()]*%/, // %USERPROFILE% — PowerShell ise waisa hi chhaap deta hai
  /^\s*start\s+""/i, // start "" "https://..." — cmd ka title slot
  // cmd switches: dir /s /b, del /q, rd /s /q, copy /y, cd /d, start /min
  /^\s*(?:dir|del|erase|copy|move|ren|rename|rd|rmdir|md|mkdir|type|start|cd|chdir)\b[^|;&]*\s\/[a-z?]{1,4}(?=\s|:|$)/i,
  // PowerShell mein ye alias kuch aur hain: sc = Set-Content (file likh deta!),
  // where = Where-Object, set = Set-Variable, curl = Invoke-WebRequest.
  /^\s*(?:set|where|sc|ver|vol|assoc|ftype|mklink|pushd|popd|curl)(?:\s|$)/i,
  /[12]?>\s*nul\b/i,
  /^\s*if\s+(?:not\s+)?(?:exist|defined|errorlevel)\b/i,
  /^\s*for\s+(?:\/[a-z]|%)/i,
];

const EXPLICIT_CMD = /^\s*"?cmd(?:\.exe)?"?(?:\s|$)/i;
const EXPLICIT_POWERSHELL = /^\s*"?(?:powershell|pwsh)(?:\.exe)?"?(?:\s|$)/i;

const looksLikePowerShell = (command) => POWERSHELL_MARKERS.some((re) => re.test(command));

/**
 * Model ne PowerShell mein %USERPROFILE% likh diya ho to use ${env:USERPROFILE}
 * bana do. Sirf wohi naam jo waqai environment mein hain — `50%` jaisa text
 * nahi chheda jaata.
 */
const rewriteCmdEnvVars = (command, env = process.env) => {
  const known = new Set(Object.keys(env || {}).map((key) => key.toUpperCase()));
  return command.replace(/%([A-Za-z_][\w()]*)%/g, (match, name) => (
    known.has(name.toUpperCase()) ? `\${env:${name}}` : match
  ));
};

/**
 * Faisla: kaunsa shell. `script` wo text hai jo asal mein chalega.
 */
const classifyWindowsCommand = (command, env = process.env) => {
  if (EXPLICIT_CMD.test(command)) return { shell: 'cmd', script: command, reason: 'explicit-cmd' };
  // Model ne khud `powershell -Command "..."` likha: us ki quoting cmd ke
  // hisaab se hai, isliye pehle ki tarah cmd se hi chalao (ye hamesha chalta tha).
  if (EXPLICIT_POWERSHELL.test(command)) return { shell: 'cmd', script: command, reason: 'explicit-powershell' };
  if (looksLikePowerShell(command)) {
    return { shell: 'powershell', script: rewriteCmdEnvVars(command, env), reason: 'powershell-syntax' };
  }
  if (CMD_ONLY_PATTERNS.some((re) => re.test(command))) return { shell: 'cmd', script: command, reason: 'cmd-syntax' };
  return { shell: 'powershell', script: command, reason: 'default' };
};

/**
 * PowerShell ka stderr model ke liye saaf karo: progress ka `#< CLIXML`
 * kachra, aur error record ke "At line:1 char:1 / + CategoryInfo" wale
 * hisse (voice budget 2000 chars hai, ye bas shor hain).
 */
const cleanPowerShellStderr = (stderr) => {
  if (!stderr) return '';
  const withoutClixml = String(stderr)
    .replace(/#< CLIXML\s*/g, '')
    .replace(/<Objs\b[\s\S]*?<\/Objs>/g, '');
  const lines = withoutClixml.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^At line:\d+ char:\d+/.test(line)) continue;
    if (/^\s*\+\s/.test(line) || /^\s*\+\s*~+\s*$/.test(line) || /^\s*\+$/.test(line)) continue;
    if (/^\s*\+ (?:CategoryInfo|FullyQualifiedErrorId)\b/.test(line)) continue;
    kept.push(line.replace(/\s+$/, ''));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

/** Tables ke aakhir wali khali jagah aur lambi khali lines hatao. */
const tidyOutput = (text) => String(text || '')
  .split(/\r?\n/)
  .map((line) => line.replace(/\s+$/, ''))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .replace(/^\n+/, '')
  .replace(/\n+$/, '');

const isDirectory = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_error) {
    return false;
  }
};

const windowsDir = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows';
const powershellPath = () => path.join(windowsDir(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmdPath = () => process.env.ComSpec || path.join(windowsDir(), 'System32', 'cmd.exe');

const killTree = (child) => new Promise((resolve) => {
  if (!child || !child.pid) return resolve();
  try {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('close', () => resolve());
    killer.once('error', () => resolve());
  } catch (_error) {
    resolve();
  }
});

/**
 * Ek process chalao aur us ke EXIT par nateeja do (pipes band hone par nahi).
 */
const runProcess = ({ file, args, cwd, env, timeoutMs, windowsVerbatimArguments, isCancelled, onChild }) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(windowsVerbatimArguments),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    resolve({ stdout: '', stderr: '', exitCode: null, spawnError: error.message });
    return;
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timedOut = false;
  let graceTimer = null;

  const collect = (chunks, which) => (chunk) => {
    const used = which === 'out' ? stdoutBytes : stderrBytes;
    if (used >= MAX_CAPTURE_BYTES) return;
    const slice = chunk.length + used > MAX_CAPTURE_BYTES ? chunk.subarray(0, MAX_CAPTURE_BYTES - used) : chunk;
    chunks.push(slice);
    if (which === 'out') stdoutBytes += slice.length; else stderrBytes += slice.length;
  };
  child.stdout.on('data', collect(stdoutChunks, 'out'));
  child.stderr.on('data', collect(stderrChunks, 'err'));
  // Grandchild (GUI app) pipe band kare ya na kare, hamein fark nahi padta.
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});

  const finish = (exitCode, extra = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(graceTimer);
    try { child.stdout.destroy(); } catch (_error) { /* already closed */ }
    try { child.stderr.destroy(); } catch (_error) { /* already closed */ }
    resolve({
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      exitCode,
      timedOut,
      cancelled: Boolean(isCancelled?.()),
      ...extra,
    });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child).then(() => finish(null));
  }, timeoutMs);

  child.once('error', (error) => finish(null, { spawnError: error.message }));
  child.once('exit', (code) => {
    // 'close' tab aata hai jab saare pipes band hon; GUI app jo seedha khuli ho
    // wo pipe pakde rakhti hai. Isliye exit par thoda sa ruk kar nikal jao.
    graceTimer = setTimeout(() => finish(code), EXIT_GRACE_MS);
  });
  child.once('close', (code) => finish(code));

  onChild?.(child);
});

const runPowerShell = (script, options) => runProcess({
  ...options,
  file: powershellPath(),
  args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_WRAPPER],
  env: { ...options.env, [COMMAND_ENV_VAR]: script },
});

// Bilkul wohi tareeqa jo Node ka exec() Windows par istemal karta hai.
const runCmd = (command, options) => runProcess({
  ...options,
  file: cmdPath(),
  args: ['/d', '/s', '/c', `"${command}"`],
  windowsVerbatimArguments: true,
});

/**
 * Model ke liye ek line ki rehnumai jab command fail ho — taake doosri
 * koshish andhi na ho.
 */
const hintFor = ({ text, timedOut, timeoutMs }) => {
  if (timedOut) {
    return `The command was still running after ${Math.round(timeoutMs / 1000)}s and was stopped. Narrow it (a smaller folder, -First 20, fewer items) or hand long jobs to an agent.`;
  }
  const lower = String(text || '').toLowerCase();
  if (/is not recognized as (?:the name of a cmdlet|an internal or external command)|knockdesk_not_found/.test(lower)) {
    return 'That program or command name does not exist on this PC. For an installed app use Start-Process with its real name or full .exe path; for a website use Start-Process "https://...".';
  }
  if (/access is denied|requires elevation|administrator|unauthorizedaccess|permission denied/.test(lower)) {
    return 'This needs administrator rights, which this tool does not have. Tell the user; retrying will not help.';
  }
  if (/cannot find path|could not find (?:a part of )?the path|the system cannot find the (?:file|path) specified|^file not found/m.test(lower)) {
    return 'The path does not exist. Search for it first (Get-ChildItem -Recurse -Filter ...) and use the exact full path.';
  }
  return '';
};

/**
 * os_exec ka asli entry point (Windows). Cancel ke liye `control.cancel()`.
 */
const createWindowsShellRun = ({ command, cwd, timeoutMs, env = process.env }) => {
  let cancelled = false;
  let current = null;
  const control = {
    cancel: async () => {
      cancelled = true;
      if (current) await killTree(current);
    },
  };

  const deadline = Date.now() + timeoutMs;
  const baseOptions = {
    cwd: cwd || os.homedir(),
    env: { ...env },
    isCancelled: () => cancelled,
    onChild: (child) => { current = child; },
  };

  const promise = (async () => {
    const plan = classifyWindowsCommand(command, env);
    // Ghalat cwd par Node "spawn powershell.exe ENOENT" deta hai — model samajhta
    // tha PowerShell hi nahi hai. Ghar wale folder mein chupke se chalana bhi
    // ghalat hoga (`Remove-Item *` ghalat jagah chal jaye), is liye saaf mana.
    if (!isDirectory(baseOptions.cwd)) {
      return {
        stdout: '', stderr: '', exitCode: null, shell: plan.shell, reason: plan.reason, timeoutMs,
        setupError: `Working directory does not exist: ${baseOptions.cwd}. Omit workingDir or pass a folder that exists.`,
      };
    }
    const run = (shell, script) => (shell === 'powershell' ? runPowerShell : runCmd)(script, {
      ...baseOptions,
      timeoutMs: Math.max(1000, deadline - Date.now()),
    });

    let shell = plan.shell;
    let result = await run(plan.shell, plan.script);
    let fellBackFrom = null;

    if (plan.shell === 'powershell' && !result.timedOut && !cancelled) {
      const stoppedBeforeRunning = result.exitCode === PS_EXIT_PARSE_ERROR || result.exitCode === PS_EXIT_NOT_FOUND;
      const isOurMarker = result.stderr.includes(PARSE_ERROR_MARKER) || result.stderr.includes(NOT_FOUND_MARKER);
      if (stoppedBeforeRunning && isOurMarker && deadline - Date.now() >= MIN_FALLBACK_BUDGET_MS) {
        // PowerShell ne kuch bhi nahi chalaya — ab cmd ko wohi command do.
        const psReason = cleanPowerShellStderr(result.stderr);
        const cmdResult = await run('cmd', command);
        fellBackFrom = 'powershell';
        shell = 'cmd';
        result = { ...cmdResult, psReason };
      }
    }

    return { ...result, shell, reason: plan.reason, fellBackFrom, timeoutMs };
  })();

  return { promise, control };
};

/**
 * Runner ka kacha nateeja IPC ke purane result shape mein (runtime-executor
 * wohi parhta hai).
 */
const toExecResult = (raw) => {
  const stdout = tidyOutput(raw.stdout).substring(0, 100000);
  let stderr = raw.shell === 'powershell' ? cleanPowerShellStderr(raw.stderr) : tidyOutput(raw.stderr);
  if (raw.fellBackFrom && raw.exitCode !== 0 && raw.psReason) {
    // Dono shells ne mana kiya: PowerShell ki wajah zyada kaam ki hai.
    stderr = [raw.psReason.replace(/^KNOCKDESK_(?:PARSE_ERROR|NOT_FOUND):\s*/, 'PowerShell: '), stderr].filter(Boolean).join('\n');
  }
  stderr = stderr.substring(0, 50000);

  let error;
  if (raw.setupError) {
    error = raw.setupError;
  } else if (raw.cancelled) {
    error = 'Command cancelled by user.';
  } else if (raw.timedOut) {
    error = `Command timed out after ${Math.round(raw.timeoutMs / 1000)}s and was stopped.`;
  } else if (raw.spawnError) {
    error = `Could not start ${raw.shell}: ${raw.spawnError}`;
  } else if (raw.exitCode !== 0) {
    error = `Command failed (exit code ${raw.exitCode}).`;
  } else if (raw.shell === 'powershell' && !stdout && stderr) {
    // PowerShell ki non-terminating error (maslan Get-Item par ghalat path):
    // exit 0 hota hai lekin kaam nahi hua. -ErrorAction SilentlyContinue wali
    // errors stderr tak aati hi nahi, is liye wo is mein nahi phanstin.
    error = 'Command reported an error.';
  }

  const hint = error ? hintFor({ text: `${stderr}\n${stdout}`, timedOut: raw.timedOut, timeoutMs: raw.timeoutMs }) : '';

  return {
    success: !error,
    stdout,
    stderr,
    error,
    hint,
    cancelled: Boolean(raw.cancelled),
    exitCode: raw.exitCode ?? -1,
    shell: raw.shell,
    fellBack: Boolean(raw.fellBackFrom),
  };
};

module.exports = {
  classifyWindowsCommand,
  cleanPowerShellStderr,
  createWindowsShellRun,
  looksLikePowerShell,
  rewriteCmdEnvVars,
  tidyOutput,
  toExecResult,
  POWERSHELL_WRAPPER,
  COMMAND_ENV_VAR,
};

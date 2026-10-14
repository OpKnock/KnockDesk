const { ipcMain, screen, app } = require('electron');
const os = require('os');

// Onboarding ka "system scan" — pehli screen par jo machine ke haqaiq dikhte hain.
//
// Usool (docs/MASTER-UI-PROMPT.md): screen par har adad asli ho. Purana
// onboarding naqli terminal dikhata tha (npm warnings, "gpt-4-turbo"); yahan
// sirf wohi aata hai jo is machine par waqai sach hai.
//
// Sirf Node ka `os` aur Electron ka `screen`: dono foran jawab dete hain, koi
// child process nahi (systeminformation PowerShell chalata hai aur dheemi
// machine par kai second leta hai — aur ye sab boot ke bilkul baad hota hai).
//
// Ye data kahin NAHI jata. Renderer isay sirf screen par dikhata hai.

const cleanCpu = (model) => String(model || '')
  .replace(/\((R|TM|C)\)/gi, '')
  .replace(/\bCPU\b/gi, '')
  .replace(/@.*$/, '')
  .replace(/\b\d+(st|nd|rd|th) Gen\b/gi, '')
  .replace(/\s+/g, ' ')
  .trim();

// 15.8 GB -> 16, 31.7 -> 32: installed RAM, na ke OS ko jo bacha.
const roundMemoryGb = (bytes) => {
  const gb = bytes / (1024 ** 3);
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  const sizes = [2, 4, 6, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256];
  const near = sizes.find((s) => gb <= s && gb > s * 0.86);
  return near || Math.round(gb);
};

const readDisplays = () => {
  try {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
      scale: Math.round(d.scaleFactor * 100),
      primary: d.id === primaryId,
    }));
  } catch {
    return [];
  }
};

const readUser = () => {
  try { return os.userInfo().username || ''; } catch { return ''; }
};

function registerOnboardingHandlers() {
  ipcMain.handle('onboarding:machine-scan', async () => {
    try {
      const cpus = os.cpus() || [];
      return {
        ok: true,
        host: os.hostname(),
        user: readUser(),
        // Windows par os.version() edition deta hai ("Windows 11 Pro").
        osName: typeof os.version === 'function' ? os.version() : os.type(),
        osBuild: os.release(),
        arch: os.arch(),
        cpu: cleanCpu(cpus[0] && cpus[0].model),
        threads: cpus.length,
        memoryGb: roundMemoryGb(os.totalmem()),
        displays: readDisplays(),
        appVersion: app.getVersion(),
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = { registerOnboardingHandlers, cleanCpu, roundMemoryGb };

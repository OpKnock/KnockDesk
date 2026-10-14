'use strict';

// ── Machine ID — "ye kaun si machine hai" ka EK jawab, har launch par wahi ──
//
// Ye id server par device slot ka naam hai (machine_registrations.device_uuid),
// KnockDesk Cloud ki device key isi se bandhi hai, aur telemetry bhi isi ko
// pehla source maanti hai. Agar ye id ek hi PC par badal jaye to server usay
// NAYI machine samajhta hai — aur Basic (1 device) wala banda apne hi PC par
// "This device needs a free slot" par atak jata hai.
//
// 22 Sept 2026 ko yehi hua. Purana formula "pehli disk ka serial" leta tha,
// aur Windows disks ki tarteeb har baar ek jaisi nahi deta: memory card ya
// USB lagi ho to wo kabhi pehle aa jati hai (serial "[" jaisa kachra), kabhi
// baad mein. Ek hi PC, do ids. DB mein kai customers ke paas ek hi hostname
// par do alag ids parhi hain — sab isi ki nishaniyan.
//
// Do tabdeeliyan, dono purane users ke liye bilkul mehfooz:
//
//   1. Disk ka intikhab ab tarteeb par nahi, MATLAB par hai: removable (USB /
//      card reader) disks aur bina serial wali disks chhor kar, sab se choti
//      drive number wali internal disk. Normal PC par yehi disk pehle bhi
//      pehli hoti thi, is liye id WAHI banti hai jo pehle se server par darj
//      hai. Formula jaan bujh kar nahi chheda — usay chherna har user ko naya
//      device bana deta.
//
//   2. Ek dafa jo id bani, wo file (`machine-id.json`) mein rakh li jati hai
//      aur us ke baad hardware se dobara poocha hi nahi jata. Bilkul wahi
//      tareeqa jo telemetry-device.json ka hai. Kal ko Windows disks ki
//      tarteeb kuch bhi de, ya WMI ek dafa jawab na de, id nahi hilti.
//
// Cache sirf tab likhi jati hai jab id bharosay ki ho (asli disk serial se
// bani ho). "nodisk" ya hostname wala fallback kabhi cache nahi hota — warna
// ek buri launch ka natija hamesha ke liye chipak jata.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FILE = 'machine-id.json';
const ID_RE = /^[0-9a-f]{32}$/;

const hashId = (raw) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);

// `\\.\PHYSICALDRIVE0` / `disk0` / `/dev/nvme0n1` — aakhri number. Jis mein
// number na ho wo sab se peeche, aur aapas mein apni asal tarteeb par (sort
// stable hai).
const driveNumber = (d) => {
  const m = /(\d+)\s*$/.exec(String((d && d.device) || ''));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

const isRemovable = (d) => {
  const it = String((d && d.interfaceType) || '').toUpperCase();
  return it.includes('USB') || it === '1394' || it === 'SD' || it === 'MMC';
};

// "[" jaise ek-do harf ke serial WMI ka kachra hain, pehchan nahi.
const hasUsableSerial = (d) => String((d && d.serialNum) || '').trim().length >= 4;

/**
 * Disk list mein se wo disk jo is machine ki pehchan ban sake.
 * Pehli pasand: internal + serial wali, sab se choti drive number.
 * Phir: koi bhi serial wali. Aakhir mein: purana rawaiya (list ki pehli).
 */
function pickDisk(disks) {
  const list = Array.isArray(disks) ? disks.filter(Boolean) : [];
  if (!list.length) return null;

  const ordered = list.slice().sort((a, b) => driveNumber(a) - driveNumber(b));

  const internal = ordered.filter((d) => !isRemovable(d) && hasUsableSerial(d));
  if (internal.length) return internal[0];

  const withSerial = ordered.filter(hasUsableSerial);
  if (withSerial.length) return withSerial[0];

  return list[0];
}

/**
 * Wahi formula jo shuru se tha: `brand-manufacturer-serial` ka SHA-256 (32 hex).
 * `reliable` = asli disk serial se bani; sirf aisi id cache hoti hai.
 */
function hardwareId({ cpu, disks }) {
  const disk = pickDisk(disks);
  const serial = (disk && disk.serialNum) || 'nodisk';
  const raw = `${cpu.brand}-${cpu.manufacturer}-${serial}`;
  return { id: hashId(raw), reliable: Boolean(disk && disk.serialNum) };
}

// Hardware parhna hi nakaam ho jaye to — bilkul pehle jaisa.
const fallbackId = () => hashId(os.hostname() + (os.cpus()[0] && os.cpus()[0].model));

function readCached(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return data && typeof data.id === 'string' && ID_RE.test(data.id) ? data.id : null;
  } catch {
    return null;
  }
}

function writeCached(dir, id) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ id, createdAt: new Date().toISOString() }));
  } catch {
    // Likh na sake to agli baar phir hardware se banegi — wahi id.
  }
}

/**
 * @param {{ userDataDir: string, si: { cpu: Function, diskLayout: Function } }} opts
 */
async function getMachineId({ userDataDir, si }) {
  const cached = userDataDir ? readCached(userDataDir) : null;
  if (cached) return cached;

  let out;
  try {
    const [cpu, disks] = await Promise.all([si.cpu(), si.diskLayout()]);
    out = hardwareId({ cpu, disks });
  } catch {
    return fallbackId();
  }

  if (out.reliable && userDataDir) writeCached(userDataDir, out.id);
  return out.id;
}

module.exports = { getMachineId, pickDisk, hardwareId, FILE };

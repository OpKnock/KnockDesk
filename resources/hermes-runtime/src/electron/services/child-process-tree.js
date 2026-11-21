'use strict';

const { spawn } = require('node:child_process');

/**
 * Terminate a child process and the processes it owns.
 *
 * Hermes' Windows launcher starts a separate Python process, so child.kill()
 * alone can leave the actual runtime running after KnockDesk closes. On POSIX,
 * owned children are launched detached so their process group can be terminated
 * without signalling the Electron process itself.
 */
function terminateOwnedProcessTree(child, options = {}) {
  if (!child || child.exitCode !== null) return false;

  const platform = options.platform || process.platform;
  const spawnProcess = options.spawnProcess || spawn;
  const killProcess = options.killProcess || process.kill;
  const pid = Number(child.pid);

  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      child.kill();
      return true;
    } catch {
      return false;
    }
  }

  if (platform === 'win32') {
    try {
      const killer = spawnProcess(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer?.once?.('error', () => {
        try {
          if (child.exitCode === null) child.kill();
        } catch {
          // The process or its tree may already have exited.
        }
      });
      return true;
    } catch {
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
      return false;
    }
  }

  if (options.detachedGroup) {
    try {
      killProcess(-pid, 'SIGKILL');
      return true;
    } catch {
      // Fall back to the direct child if it was not started as a process group.
    }
  }

  try {
    child.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate an owned process tree and wait briefly for the direct child to exit.
 * The timeout repeats tree termination as a guard against a delayed taskkill.
 */
function stopOwnedChild(child, timeoutMs = 2500, options = {}) {
  if (!child || child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve();
    };

    child.once('exit', finish);
    timer = setTimeout(() => {
      if (child.exitCode === null) terminateOwnedProcessTree(child, options);
      finish();
    }, timeoutMs);

    terminateOwnedProcessTree(child, options);
    if (child.exitCode !== null) finish();
  });
}

module.exports = { stopOwnedChild, terminateOwnedProcessTree };

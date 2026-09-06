const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const app = path.join(process.env.ABRA_INSTALL_DIR, 'Abra Teleport.exe');
const core = path.join(process.env.ABRA_INSTALL_DIR, 'resources/Runtime/abra.exe');
const root = path.join(process.env.RUNNER_TEMP, 'abra node smoke');
function run(exe, args, timeout = 10000, env = {}) {
  const start = Date.now();
  const result = spawnSync(exe, args, {encoding:'utf8', timeout, windowsHide:true, env:{...process.env,...env}});
  console.log(JSON.stringify({command:args, ms:Date.now()-start, status:result.status, signal:result.signal, error:result.error?.message, stdout:result.stdout?.slice(0,2000), stderr:result.stderr?.slice(0,2000)}));
  return result;
}
run(app, ['-e', 'console.log(process.versions.node)'], 10000, {ELECTRON_RUN_AS_NODE:'1'});
run(core, ['--version']);
const result = run(core, ['--root',root,'--json','daemon','--background','--yes','--transport','tcp'], 25000);
for (const file of ['daemon.log','daemon.pid']) {
  try { console.log(file, fs.readFileSync(path.join(root,file),'utf8').slice(-6000)); } catch (error) { console.log(file,error.code); }
}
run(core,['--root',root,'--json','status'],5000);
run(core,['--root',root,'--json','stop'],15000);
if (result.status !== 0) process.exitCode=1;

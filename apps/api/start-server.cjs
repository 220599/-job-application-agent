const { spawn } = require('child_process');

const server = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
  cwd: 'C:\\Users\\shubh\\Documents\\personal projects\\Job Application\\apps\\api',
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
});

server.stdout.on('data', (data) => {
  console.log(`STDOUT: ${data}`);
});

server.stderr.on('data', (data) => {
  console.error(`STDERR: ${data}`);
});

server.on('close', (code) => {
  console.log(`Server process exited with code ${code}`);
});

server.unref();

console.log('Server started in background, PID:', server.pid);

// Keep the script alive for 60 seconds
setTimeout(() => {
  console.log('Test script ending');
}, 60000);
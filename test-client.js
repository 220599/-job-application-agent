const http = require('http');

const options = {
  hostname: 'localhost',
  port: 4001,
  path: '/health',
  method: 'GET'
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => { console.log('Response:', data); });
});

req.on('error', (e) => { console.error('Error:', e.message); });
req.end();
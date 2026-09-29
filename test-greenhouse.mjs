import * as undici from 'undici';
import { createGunzip } from 'zlib';
const { request } = undici;

const url = 'https://job-boards.greenhouse.io/taskrabbit/jobs/8234605';

try {
  const { statusCode, headers, body } = await request(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; JobApplicationAgent/1.0; +https://github.com/job-application-agent)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
    },
  });
  
  console.log('Status:', statusCode);
  console.log('Content-Type:', headers['content-type']);
  console.log('Content-Encoding:', headers['content-encoding']);
  
  const contentEncoding = headers['content-encoding'] || '';
  let stream = body;
  if (contentEncoding.includes('gzip')) {
    const zlib = await import('zlib');
    stream = body.pipe(zlib.createGunzip());
  } else if (contentEncoding.includes('deflate')) {
    const zlib = await import('zlib');
    stream = body.pipe(zlib.createInflate());
  }
  
  let chunks = [];
  let totalSize = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    totalSize += chunk.length;
    if (totalSize > 100000) break;
  }
  
  const html = Buffer.concat(chunks).toString('utf-8');
  
  // Look for JSON-LD
  const jsonLdMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
  if (jsonLdMatches) {
    console.log('=== JSON-LD FOUND ===');
    jsonLdMatches.forEach((m, i) => console.log(i, m.substring(0, 1000)));
  } else {
    console.log('No JSON-LD found');
  }
  
  // Look for job title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) console.log('Title:', titleMatch[1]);
  
  // Look for og:title
  const ogTitleMatch = html.match(/property="og:title" content="([^"]+)"/i);
  if (ogTitleMatch) console.log('og:title:', ogTitleMatch[1]);
  
  // Look for location in og:description
  const ogDescMatch = html.match(/property="og:description" content="([^"]+)"/i);
  if (ogDescMatch) console.log('og:description:', ogDescMatch[1]);
  
  // Look for Greenhouse-specific elements
  console.log('\n=== Looking for Greenhouse elements ===');
  const greenhouseElements = [
    'job-title',
    'job-location',
    'company-name',
    'job-description',
    'job-post',
    'job-post-container',
    'content',
    'description',
  ];
  
  greenhouseElements.forEach(cls => {
    const regex = new RegExp(`class="[^"]*${cls}[^"]*"`, 'gi');
    const matches = html.match(regex);
    if (matches) console.log(cls, 'found:', matches.length, 'times');
  });
  
  // Extract job post content area
  const jobPostMatch = html.match(/class="job-post-container"[^>]*>([\s\S]*?)<\/main>/i);
  if (jobPostMatch) {
    console.log('\n=== Job Post Container (first 5000) ===');
    console.log(jobPostMatch[1].substring(0, 5000));
  }
  
  // Save full HTML for inspection
  const fs = await import('fs');
  fs.writeFileSync('greenhouse-test.html', html);
  console.log('\nFull HTML saved to greenhouse-test.html');
} catch (err) {
  console.error('Error:', err.message);
}
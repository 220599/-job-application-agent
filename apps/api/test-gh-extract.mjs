import * as cheerio from 'cheerio';
import * as fs from 'fs';

const html = fs.readFileSync(process.env.USERPROFILE + '/gh-test.html', 'utf-8');
const $ = cheerio.load(html);

// Current code's selectors
const t1 = $('.job__header .job__title h1.section-header, .job__title h1, .job-post .job__header h1').first().text().trim();
console.log('title selector 1:', JSON.stringify(t1));

const c1 = $('.job-post-container .image-container .logo img').first().attr('alt');
console.log('company selector (.logo img):', JSON.stringify(c1));

const c2 = $('.job-post-container .image-container img.logo').first().attr('alt');
console.log('company selector (img.logo):', JSON.stringify(c2));

const loc = $('.job__header .job__location div, .job__location').first().text().trim();
console.log('location:', JSON.stringify(loc));

const desc = $('.job__description.body, .job__description').first().html();
console.log('description found:', !!desc, desc ? desc.length : 0);

// remixContext
const m = html.match(/window\.__remixContext = (\{[\s\S]*?\});<\/script>/);
console.log('remixContext found:', !!m);
if (m) {
  try {
    const ctx = JSON.parse(m[1]);
    const jobPost = ctx?.state?.loaderData?.['routes/$url_token_.jobs_.$job_post_id']?.jobPost;
    if (jobPost) {
      console.log('jobPost.title:', jobPost.title);
      console.log('jobPost.company_name:', jobPost.company_name);
      console.log('jobPost.job_post_location:', jobPost.job_post_location);
      console.log('jobPost.public_url:', jobPost.public_url);
      console.log('jobPost.published_at:', jobPost.published_at);
      console.log('jobPost.submitPath:', ctx?.state?.loaderData?.['routes/$url_token_.jobs_.$job_post_id']?.submitPath);
      console.log('jobPost.content length:', jobPost.content?.length);
      console.log('pay_ranges:', JSON.stringify(jobPost.pay_ranges?.map(p => ({ min: p.min, max: p.max, currency: p.currency_type }))));
      console.log('jobPostId:', ctx?.state?.loaderData?.['routes/$url_token_.jobs_.$job_post_id']?.jobPostId);
    } else {
      console.log('jobPost NOT FOUND in remixContext');
    }
  } catch (e) {
    console.log('remixContext parse failed:', e.message);
  }
}

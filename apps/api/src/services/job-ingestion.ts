import * as cheerio from 'cheerio';
import * as undici from 'undici';
import { prisma } from '@jaa/database';
import type { Job as PrismaJob } from '@jaa/database';
import {
  JobCreate,
  jobCreateSchema,
} from '@jaa/shared';
import { URL } from 'url';

type Job = PrismaJob;

const { request: undiciRequest } = undici;

function isGreenhouseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'job-boards.greenhouse.io' && parsed.pathname.includes('/jobs/');
  } catch {
    return false;
  }
}

const PRIVATE_IP_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^::1$/,
  /^fe80::/,
  /^fc00::/,
];

const BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  'metadata',
  '169.254.169.254',
];

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 15000;

export interface IngestionResult {
  job: Job;
  created: boolean;
}

export interface ExtractedJobData {
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  employmentType: string | null;
  workMode: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  requirements: string[] | null;
  responsibilities: string[] | null;
  skills: string[] | null;
  externalId: string | null;
  postedAt: Date | null;
  rawHtml: string | null;
}

function isPrivateOrBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return true;
    }

    const hostname = parsed.hostname.toLowerCase();

    if (BLOCKED_HOSTS.includes(hostname)) {
      return true;
    }

    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(hostname)) {
        return true;
      }
    }

    if (parsed.username || parsed.password) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function validateUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only HTTP/HTTPS URLs are allowed' };
    }

    if (isPrivateOrBlockedUrl(url)) {
      return { valid: false, error: 'URL points to a blocked or private address' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const { statusCode, headers, body } = await undiciRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JobApplicationAgent/1.0; +https://github.com/job-application-agent)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (statusCode >= 400) {
      throw new Error(`HTTP ${statusCode}: Failed to fetch job page`);
    }

    const contentType = headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error('Response is not HTML content');
    }

    const contentEncoding = headers['content-encoding'] || '';
    let stream: AsyncIterable<Uint8Array> = body;
    if (contentEncoding.includes('gzip')) {
      const zlib = await import('zlib');
      stream = body.pipe(zlib.createGunzip()) as AsyncIterable<Uint8Array>;
    } else if (contentEncoding.includes('deflate')) {
      const zlib = await import('zlib');
      stream = body.pipe(zlib.createInflate()) as AsyncIterable<Uint8Array>;
    }

    let chunks: Uint8Array[] = [];
    let totalSize = 0;

    for await (const chunk of stream) {
      chunks.push(chunk);
      totalSize += chunk.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        throw new Error('Response size exceeds maximum allowed');
      }
    }

    return Buffer.concat(chunks).toString('utf-8');
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
    throw new Error('Unknown fetch error');
  }
}

function extractJsonLd($: cheerio.CheerioAPI): ExtractedJobData | null {
  const scripts = $('script[type="application/ld+json"]');
  
  for (const script of scripts.toArray()) {
    const content = $(script).html();
    if (!content) continue;

    try {
      const data = JSON.parse(content);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (item['@type'] === 'JobPosting' || 
            (Array.isArray(item['@type']) && item['@type'].includes('JobPosting'))) {
          
          const hiringOrg = item.hiringOrganization;
          const jobLocation = item.jobLocation;
          const baseSalary = item.baseSalary;

          return {
            title: item.title || null,
            company: hiringOrg?.name || null,
            location: jobLocation?.address?.addressLocality 
              ? `${jobLocation.address.addressLocality}${jobLocation.address.addressRegion ? ', ' + jobLocation.address.addressRegion : ''}${jobLocation.address.addressCountry ? ', ' + jobLocation.address.addressCountry : ''}`
              : jobLocation?.name || null,
            description: item.description ? decodeHtmlEntities(item.description) : null,
            employmentType: Array.isArray(item.employmentType) ? item.employmentType[0] : item.employmentType || null,
            workMode: item.jobLocation?.['@type'] === 'Place' && jobLocation?.address?.['@type'] === 'PostalAddress' 
              ? null 
              : null,
            salaryMin: baseSalary?.value?.minValue ? parseInt(baseSalary.value.minValue) : null,
            salaryMax: baseSalary?.value?.maxValue ? parseInt(baseSalary.value.maxValue) : null,
            salaryCurrency: baseSalary?.value?.currency || 'USD',
            requirements: item.qualifications ? (Array.isArray(item.qualifications) ? item.qualifications : [item.qualifications]) : null,
            responsibilities: item.responsibilities ? (Array.isArray(item.responsibilities) ? item.responsibilities : [item.responsibilities]) : null,
            skills: item.skills ? (Array.isArray(item.skills) ? item.skills : [item.skills]) : null,
            externalId: item.identifier?.value || item.identifier || null,
            postedAt: item.datePosted ? new Date(item.datePosted) : null,
            rawHtml: null,
          };
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function extractGreenhouse($: cheerio.CheerioAPI): ExtractedJobData {
  const text = (selector: string) => $(selector).first().text().trim() || null;
  const html = (selector: string) => $(selector).first().html() || null;
  const attr = (selector: string, attrName: string) => $(selector).first().attr(attrName) || null;

  // Title from Greenhouse-specific structure
  const title = 
    text('.job__header .job__title h1.section-header, .job__title h1, .job-post .job__header h1') ||
    attr('meta[property="og:title"]', 'content') ||
    null;

  // Company from logo alt or link. Handles both Greenhouse logo DOM variants:
  //  - <div class="logo"><img alt="Acme Logo"/></div>  (older boards)
  //  - <img class="logo" alt="Acme Logo"/>             (current boards)
  const company = 
    attr('.job-post-container .image-container img.logo, .job-post-container .image-container .logo img', 'alt')?.replace(' Logo', '') ||
    attr('.job-post-container .image-container .logo', 'href')?.split('/').pop()?.replace(/-/g, ' ') ||
    attr('meta[property="og:site_name"]', 'content') ||
    $('title').first().text().match(/Job Application for .+ at (.+)$/i)?.[1]?.trim() ||
    null;

  // Location from Greenhouse-specific structure
  const location = 
    text('.job__header .job__location div, .job__location, [class*="job__location"]') ||
    attr('meta[property="og:description"]', 'content') ||
    null;

  // Description from Greenhouse-specific structure
  const descriptionHtml = 
    html('.job__description.body, .job__description, [class*="job__description"]') ||
    html('.job-post .job__description') ||
    null;
  
  const description = descriptionHtml ? cleanHtml(decodeHtmlEntities(descriptionHtml)) : null;

  // External job ID from URL or page
  const externalId = attr('link[rel="canonical"]', 'href')?.split('/').pop() || null;

  // Requirements and responsibilities from description parsing
  let requirements: string[] | null = null;
  let responsibilities: string[] | null = null;
  
  if (descriptionHtml) {
    const $desc = cheerio.load(descriptionHtml);
    const reqItems = $desc('h2:contains("Requirement"), h3:contains("Requirement"), strong:contains("Requirement")')
      .nextUntil('h2, h3').find('li').map((_, el) => $desc(el).text().trim()).get();
    if (reqItems.length > 0) requirements = reqItems;
    
    const respItems = $desc('h2:contains("Responsibilit"), h3:contains("Responsibilit"), strong:contains("Responsibilit")')
      .nextUntil('h2, h3').find('li').map((_, el) => $desc(el).text().trim()).get();
    if (respItems.length > 0) responsibilities = respItems;
  }

  // Posted date - Greenhouse sometimes includes this
  const postedAtText = text('.job__posted-date, .job-post-date, [class*="posted-date"]');
  let postedAt: Date | null = null;
  if (postedAtText) {
    const parsed = new Date(postedAtText);
    if (!isNaN(parsed.getTime())) postedAt = parsed;
  }

  return {
    title,
    company,
    location,
    description,
    employmentType: null,
    workMode: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: 'USD',
    requirements,
    responsibilities,
    skills: null,
    externalId,
    postedAt,
    rawHtml: null,
  };
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '"',
    '&apos;': "'",
    '&ndash;': '-',
    '&mdash;': '-',
    '&lsquo;': "'",
    '&rsquo;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&bull;': '*',
    '&hellip;': '...',
  };

  return text.replace(/&[a-z]+;/gi, (match) => entities[match] || match)
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFromHtml($: cheerio.CheerioAPI): ExtractedJobData {
  const text = (selector: string) => $(selector).first().text().trim() || null;
  const html = (selector: string) => $(selector).first().html() || null;
  const attr = (selector: string, attrName: string) => $(selector).first().attr(attrName) || null;

  const ogTitle = attr('meta[property="og:title"]', 'content');
  const ogDescription = attr('meta[property="og:description"]', 'content');
  const ogSiteName = attr('meta[property="og:site_name"]', 'content');
  
  const twitterTitle = attr('meta[name="twitter:title"]', 'content');
  const twitterDescription = attr('meta[name="twitter:description"]', 'content');

  const descriptionMeta = attr('meta[name="description"]', 'content');

  const title = 
    text('h1.job-title, h1[data-testid="job-title"], h1.title, .job-title h1, .position-title') ||
    text('h1') ||
    ogTitle ||
    twitterTitle ||
    $('title').first().text().trim() ||
    null;

  const company = 
    text('.company-name, .employer-name, [data-testid="company-name"], .company a, .employer a') ||
    attr('[itemprop="hiringOrganization"] [itemprop="name"]', 'content') ||
    ogSiteName ||
    null;

  const location = 
    text('.job-location, .location, [data-testid="location"], [itemprop="jobLocation"] [itemprop="addressLocality"]') ||
    text('[itemprop="addressLocality"]') ||
    null;

  const descriptionHtml = 
    html('.job-description, .description, [data-testid="job-description"], [itemprop="description"], .job-details, .posting-description') ||
    html('main article') ||
    html('.content') ||
    null;

  const description = descriptionHtml ? cleanHtml(decodeHtmlEntities(descriptionHtml)) : (ogDescription || twitterDescription || descriptionMeta);

  const workModeText = (text('.work-type, .remote-type, [data-testid="work-type"], .job-type') || '').toLowerCase();
  let workMode: string | null = null;
  if (workModeText) {
    if (workModeText.includes('remote') && !workModeText.includes('hybrid')) workMode = 'REMOTE';
    else if (workModeText.includes('hybrid')) workMode = 'HYBRID';
    else if (workModeText.includes('onsite') || workModeText.includes('on-site') || workModeText.includes('office')) workMode = 'ONSITE';
  }

  const salaryText = (text('.salary, .compensation, [data-testid="salary"], .pay-range') || '').toLowerCase();
  let salaryMin: number | null = null;
  let salaryMax: number | null = null;
  let salaryCurrency: string | null = 'USD';
  if (salaryText) {
    const matches = salaryText.match(/\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*[-–]\s*\$?(\d+(?:,\d{3})*(?:\.\d+)?)/);
    if (matches) {
      salaryMin = parseInt(matches[1].replace(/,/g, ''));
      salaryMax = parseInt(matches[2].replace(/,/g, ''));
    } else {
      const singleMatch = salaryText.match(/\$?(\d+(?:,\d{3})*(?:\.\d+)?)/);
      if (singleMatch) {
        salaryMin = parseInt(singleMatch[1].replace(/,/g, ''));
      }
    }
  }

  const requirementsList = $('.requirements li, .qualifications li, [data-testid="requirements"] li').map((_i: number, el: any) => $(el).text().trim()).get();
  const responsibilitiesList = $('.responsibilities li, .duties li, [data-testid="responsibilities"] li').map((_i: number, el: any) => $(el).text().trim()).get();
  const skillsList = $('.skills li, .tags li, [data-testid="skills"] li, .tech-stack li').map((_i: number, el: any) => $(el).text().trim()).get();

  return {
    title,
    company,
    location,
    description,
    employmentType: null,
    workMode,
    salaryMin,
    salaryMax,
    salaryCurrency,
    requirements: requirementsList.length > 0 ? requirementsList : null,
    responsibilities: responsibilitiesList.length > 0 ? responsibilitiesList : null,
    skills: skillsList.length > 0 ? skillsList : null,
    externalId: null,
    postedAt: null,
    rawHtml: null,
  };
}

function normalizeJobData(data: ExtractedJobData, sourceUrl: string): JobCreate {
  const hostname = new URL(sourceUrl).hostname.replace(/^www\./, '');
  
  let source = 'UNKNOWN';
  if (hostname.includes('greenhouse')) source = 'GREENHOUSE';
  else if (hostname.includes('lever')) source = 'LEVER';
  else if (hostname.includes('ashby')) source = 'ASHBY';
  else if (hostname.includes('workable')) source = 'WORKABLE';
  else if (hostname.includes('workday')) source = 'WORKDAY';
  else if (hostname.includes('smartrecruiters')) source = 'SMARTRECRUITERS';
  else if (hostname.includes('icims')) source = 'ICIMS';
  else if (hostname.includes('bamboohr')) source = 'BAMBOOHR';
  else if (hostname.includes('jobvite')) source = 'JOBVITE';
  else if (hostname.includes('taleo')) source = 'TALEO';

  return {
    externalId: data.externalId || undefined,
    source,
    ats: source !== 'UNKNOWN' ? source : undefined,
    url: sourceUrl,
    company: data.company || 'Unknown Company',
    title: data.title || 'Untitled Position',
    location: data.location || undefined,
    description: data.description || undefined,
    employmentType: data.employmentType || undefined,
    workMode: data.workMode || undefined,
    salaryMin: data.salaryMin || undefined,
    salaryMax: data.salaryMax || undefined,
    salaryCurrency: data.salaryCurrency || 'USD',
    requirements: data.requirements || undefined,
    responsibilities: data.responsibilities || undefined,
    skills: data.skills || undefined,
    postedAt: data.postedAt || undefined,
  };
}

export async function ingestJobFromUrl(url: string, userId: string): Promise<IngestionResult> {
  const validation = validateUrl(url);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid URL');
  }

  const normalizedUrl = url.endsWith('/') ? url.slice(0, -1) : url;

  const existingJob = await prisma.job.findUnique({
    where: { url: normalizedUrl },
  });

  if (existingJob) {
    return { job: existingJob, created: false };
  }

  let html: string;
  try {
    html = await fetchPage(normalizedUrl);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`FETCH_FAILED: ${error.message}`);
    }
    throw new Error('FETCH_FAILED: Unknown error');
  }

  const $ = cheerio.load(html);

  let extracted = extractJsonLd($);
  
  // Try Greenhouse-specific extractor for Greenhouse URLs
  if (!extracted && isGreenhouseUrl(normalizedUrl)) {
    extracted = extractGreenhouse($);
  }
  
  if (!extracted) {
    extracted = extractFromHtml($);
  }

  if (!extracted.title || !extracted.company) {
    throw new Error('EXTRACTION_FAILED: Could not extract job title or company');
  }

  const jobData = normalizeJobData(extracted, normalizedUrl);

  const validatedData = jobCreateSchema.parse(jobData);

  const job = await prisma.job.create({
    data: {
      ...validatedData,
      user: { connect: { id: userId } },
    },
  });

  return { job, created: true };
}
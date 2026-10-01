/**
 * Phase 5b - Resume → Profile parsing (deterministic, no AI)
 *
 * Given a PDF/DOCX buffer, extracts raw text (pdf-parse / mammoth) and
 * parses the candidate's profile sections: contact info, skills,
 * experience, education. Deterministic heuristics only - the same resume
 * always yields the same structured result.
 *
 * Semantics contract used by the import flow:
 *  - Only fields with a confident value are returned (null otherwise).
 *  - The caller decides what to overwrite; the standard flow only fills
 *    EMPTY profile fields so candidate-typed data is never clobbered.
 */
import { prisma } from '@jaa/database';
import type { Resume, ResumeVersion } from '@jaa/database';

// ============================================================================
// Text extraction
// ============================================================================

export async function extractResumeText(buffer: Buffer, mimeType: string): Promise<string> {
  // pdf-parse and mammoth are CommonJS packages; load them via createRequire
  // so ESM/tsx interop differences can never change what we call.
  const { createRequire } = await import('module');
  const requireCjs = createRequire(import.meta.url);

  if (mimeType === 'application/pdf') {
    // Load the library entrypoint directly - the package index has a brittle
    // debug/test mode that triggers when imported without arguments.
    const pdfParse = requireCjs('pdf-parse/lib/pdf-parse.js');
    const result = await pdfParse(buffer);
    return typeof result?.text === 'string' ? result.text : '';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = requireCjs('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    return typeof value === 'string' ? value : '';
  }
  throw new Error(`UNSUPPORTED_TYPE: Cannot extract text from ${mimeType}`);
}

// ============================================================================
// Parsing helpers
// ============================================================================

export interface ParsedProfile {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  summary: string | null;
  skills: string[];
  experience: {
    company: string;
    title: string;
    startDate?: string | null; // ISO or partial (YYYY-MM)
    endDate?: string | null;
    isCurrent: boolean;
    description?: string | null;
  }[];
  education: {
    institution: string;
    degree: string;
    fieldOfStudy: string;
    startDate?: string | null;
    endDate?: string | null;
  }[];
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

function monthToNum(token: string): string | null {
  const t = token.toLowerCase();
  if (/^\d{1,2}$/.test(t)) {
    const n = parseInt(t, 10);
    return n >= 1 && n <= 12 ? String(n).padStart(2, '0') : null;
  }
  // Accept full month names by their 3-letter prefix (march -> mar).
  return MONTHS[t.slice(0, 3)] ?? null;
}

/** Parse "March 2020", "Mar 2020", "05/2019", "2019" -> "2019-03" style. */
export function parseDateToken(token: string): string | null {
  const cleaned = token.trim().replace(/,$/, '');
  let m = cleaned.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const mm = monthToNum(m[1]);
    if (mm) return `${m[2]}-${mm}`;
  }
  m = cleaned.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = cleaned.match(/^(\d{4})$/);
  if (m) return cleaned;
  return null;
}

const SECTION_HEADERS: { key: keyof SectionMap; patterns: RegExp[] }[] = [
  { key: 'summary', patterns: [/^(professional\s+)?summary\b/i, /^about\s+me\b/i, /^objective\b/i, /^profile\b/i] },
  { key: 'skills', patterns: [/^(technical\s+)?skills\b/i, /^core\s+competenc/i, /^technologies\b/i, /^tech\s+stack\b/i] },
  { key: 'experience', patterns: [/^experience\b/i, /^(work|professional|relevant|employment)\s+(experience|history)\b/i, /^(employment|career)\s+history\b/i] },
  { key: 'education', patterns: [/^education(\s+(&|and)\s+training)?\b/i, /^academic(\s+background)?\b/i] },
  { key: 'projects', patterns: [/^projects?\b/i, /^personal\s+projects?\b/i] },
  { key: 'certifications', patterns: [/^certifications?\b/i, /^licenses?\b/i] },
];

interface SectionMap {
  header?: string[];
  summary?: string[];
  skills?: string[];
  experience?: string[];
  education?: string[];
  projects?: string[];
  certifications?: string[];
}

function detectSection(line: string): keyof SectionMap | null {
  const trimmed = line.trim().replace(/[:•\-*]+$/, '').trim();
  if (trimmed.length === 0 || trimmed.length > 60) return null;
  for (const { key, patterns } of SECTION_HEADERS) {
    if (patterns.some((p) => p.test(trimmed))) return key;
  }
  return null;
}

/** Split a text block into lines, dropping bullets glyphs and page numbers. */
function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .map((l) => l.replace(/^[•·▪◦‣⁃*\-–—]\s*/, (mm) => (mm.trim() === '-' ? mm : '')))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\s*(page\s*\d+(\s*of\s*\d+)?)\s*$/i.test(l));
}

function parseSkillsSection(lines: string[]): string[] {
  const text = lines
    .map((l) => l.replace(/^[A-Za-z][A-Za-z /&-]{0,30}:\s*/, '')) // strip "Languages:" style category prefixes
    .join('\n');
  const skills = text
    .split(/\n|[,;•|·]|\s{2,}|\b(?:and)\b(?=[\sA-Z])/gi)
    .map((s) => s.replace(/^[^A-Za-z0-9+#.]+|[^A-Za-z0-9+#.)]+$/g, '').trim())
    .filter((s) => s.length >= 2 && s.length <= 40 && /[A-Za-z]/.test(s))
    .filter((s) => !/^(e\.?g\.?|etc|including|such as|proficien|experienced|familiar)$/i.test(s));
  return [...new Set(skills)].slice(0, 40);
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9._-]+/i;
const GITHUB_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9._-]+/i;

/** URL that is not linkedin/github - treated as portfolio/website. */
const OTHER_URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?[^\s,;)]*/i;

function parseContact(lines: string[]): Partial<ParsedProfile> {
  const head = lines.slice(0, 12).join('\n');
  const out: Partial<ParsedProfile> = {};

  const email = head.match(EMAIL_RE)?.[0];
  if (email) out.email = email.toLowerCase();

  const phone = head.match(PHONE_RE)?.[0];
  if (phone) out.phone = phone.trim();

  const linkedin = head.match(LINKEDIN_RE)?.[0];
  if (linkedin) out.linkedinUrl = linkedin.startsWith('http') ? linkedin : `https://${linkedin}`;

  const github = head.match(GITHUB_RE)?.[0];
  if (github) out.githubUrl = github.startsWith('http') ? github : `https://${github}`;

  // First non-email/phone/URL line at the very top is usually "First Last"
  const nameLine = lines
    .slice(0, 4)
    .find(
      (l) =>
        !EMAIL_RE.test(l) &&
        !PHONE_RE.test(l) &&
        !/(linkedin|github|https?:\/\/)/i.test(l) &&
        /^[A-Za-z][A-Za-z'.-]+(\s+[A-Za-z][A-Za-z'.-]+){1,3}$/.test(l.trim())
    );
  if (nameLine) {
    const parts = nameLine.trim().split(/\s+/);
    out.firstName = parts[0];
    out.lastName = parts[parts.length - 1];
  }

  // Location: "City, ST 12345" or "City, <known state/country>". The second
  // alternative only accepts known region names so skill lists like
  // "SQL, Python" can never be mistaken for a location.
  const KNOWN_REGIONS = new Set(
    (
      'alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada newhampshire newjersey newmexico newyork northcarolina northdakota ohio oklahoma oregon pennsylvania rhodeisland southcarolina southdakota tennessee texas utah vermont virginia washington westvirginia wisconsin wyoming ' +
      'india canada unitedstates usa uk england germany france australia singapore ireland netherlands'
    ).split(' ')
  );
  // Only accept state abbreviations from the real US state list - arbitrary
  // two-letter words (QA, KPI, AI...) would otherwise match.
  const US_STATES = new Set(
    ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC').split(' ')
  );
  for (const line of lines.slice(0, 10)) {
    // "City, ST" or "City, ST 12345" with a real state code
    const m = line.match(/([A-Z][A-Za-z .'-]+,\s*([A-Z]{2}))(\s+\d{5})?/);
    if (m && US_STATES.has(m[2])) {
      out.location = m[1].replace(/\s+/g, ' ').trim();
      break;
    }
    // "City, New York" / "City, India" style with a known region name
    const m2 = line.match(/([A-Z][A-Za-z .'-]+,\s*(?:[A-Z][a-z]+\s+){0,2}[A-Z][a-z]+)/);
    if (m2) {
      const region = m2[1].split(',').pop()!.replace(/\s+/g, '').toLowerCase();
      if (KNOWN_REGIONS.has(region)) {
        out.location = m2[1].replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }

  return out;
}

const KNOWN_DEGREE_WORDS =
  /(b\.?s\.?c?\.?|b\.?a\.?|b\.?tech|b\.?e\.?|m\.?s\.?c?\.?|m\.?a\.?|m\.?tech|m\.?b\.?a\.?|ph\.?d\.?|associate|bachelor|master|doctorate|diploma)/i;

function parseEducation(lines: string[]): ParsedProfile['education'] {
  const results: ParsedProfile['education'] = [];
  let current: ParsedProfile['education'][number] | null = null;

  for (const line of lines) {
    const dateMatch = line.match(
      /((?:[A-Za-z]{3,9}\.?\s+)?\d{4})\s*(?:-|–|—|to)\s*((?:[A-Za-z]{3,9}\.?\s+)?\d{4}|Present|Current)/i
    );
    const startDate = dateMatch ? parseDateToken(dateMatch[1]) : null;
    const endDateRaw = dateMatch ? dateMatch[2] : null;
    const endDate =
      endDateRaw && !/present|current/i.test(endDateRaw) ? parseDateToken(endDateRaw) : null;
    const isCurrent = !!endDateRaw && /present|current/i.test(endDateRaw);

    const content = dateMatch
      ? (line.slice(0, dateMatch.index ?? 0).replace(/[\s(|·,\-–—]+$/, '') + ' ' +
         line.slice((dateMatch.index ?? 0) + dateMatch[0].length).replace(/^[\s)|·,\-–—]+/, '')).trim()
      : line;
    if (KNOWN_DEGREE_WORDS.test(content)) {
      if (current) results.push(current);
      const contentNoDegree = content.replace(KNOWN_DEGREE_WORDS, '').trim();
      // "B.S. Computer Science - University of Texas" layout: split on ' - '
      const dashSplit = contentNoDegree.split(/\s+[-\u2013\u2014|]\s+/);
      const institution =
        (dashSplit.length === 2
          ? dashSplit[1].trim()
          : contentNoDegree.replace(/[,|·]\s*$/, '').trim()) || content.trim();
      current = {
        institution,
        degree: (content.match(KNOWN_DEGREE_WORDS)?.[0] ?? '').trim(),
        fieldOfStudy: dashSplit.length === 2 ? dashSplit[0].trim() : '',
        startDate,
        endDate: isCurrent ? null : endDate,
      };
    } else if (current && !current.fieldOfStudy && content.length > 0 && content.length < 80) {
      current.fieldOfStudy = content;
    }
  }
  if (current) results.push(current);
  return results
    .filter((e) => e.institution.length > 2)
    .map((e) => ({
      ...e,
      degree: e.degree || 'Degree',
      fieldOfStudy: e.fieldOfStudy || 'General',
    }));
}

const EMPLOYMENT_KEYWORDS =
  /(intern|engineer|developer|analyst|manager|consultant|scientist|designer|specialist|administrator|architect|associate|lead|director|president|coordinator|officer|technician|research|assistant|teacher|accountant|nurse|advisor|executive|founder|owner|freelance|contributor|member)/i;

/**
* Fix PDF word-gluing like "T-MobileNew York, NY": split at the
* lowercase->uppercase transition before a ", ST" suffix.
*/
function stripGluedLocation(company: string): string {
  const m = company.match(/^(.+[a-z])([A-Z][A-Za-z .'-]*),\s*[A-Z]{2}$/);
  return m ? m[1].trim() : company.trim();
}

/**
* Detect a standalone "Title - Company" header line (no dates) and decide
* which side is the title via the role-keyword heuristic.
* Returns null for lines that don't look like a title/company header.
*/
function looksLikeTitleCompany(line: string): { title: string; company: string } | null {
  if (line.length > 80) return null;
  const sepMatch = line.match(/^(.+?)\s+(?:-|–|—|\|)\s+(.+)$/);
  if (!sepMatch) return null;
  const left = sepMatch[1].trim();
  const right = sepMatch[2].trim();
  const leftHasRole = EMPLOYMENT_KEYWORDS.test(left);
  const rightHasRole = EMPLOYMENT_KEYWORDS.test(right);
  let title: string;
  let company: string;
  if (rightHasRole && !leftHasRole) {
    company = left;
    title = right;
  } else {
    title = left;
    company = right;
  }
  if (title.split(/\s+/).length > 8) return null;
  return { title, company: stripGluedLocation(company) };
}

function parseExperience(lines: string[]): ParsedProfile['experience'] {
  const results: ParsedProfile['experience'] = [];
  let current: ParsedProfile['experience'][number] | null = null;
  let bullets: string[] = [];

  // Carry-over for layouts where the title line and the date line are separate
  // (e.g. "Data Engineer – T-MobileNew York, NY" / "August 2023 – Current").
  let pendingHeader: { title: string; company: string } | null = null;

  for (const line of lines) {
    const dateMatch = line.match(
      /((?:[A-Za-z]{3,9}\.?\s+)?\d{4})\s*(?:-|–|—|to)\s*((?:[A-Za-z]{3,9}\.?\s+)?\d{4}|Present|Current)/i
    );

    if (dateMatch) {
      if (current) {
        current.description = bullets.length > 0 ? bullets.join('\n') : null;
        results.push(current);
      }
      const endDateRaw = dateMatch[2];
      const isCurrent = /present|current/i.test(endDateRaw);
      // Split around the matched date span and strip layout artifacts
      // ("(" before dates, ")" after them, separators) BEFORE deciding
      // which side is the title and which is the company.
      const matchedStartIdx = dateMatch.index ?? 0;
      const matchedLen = dateMatch[0].length;
      const before = line
        .slice(0, matchedStartIdx)
        .replace(/[\s(|·,\-–—]+$/, '')
        .trim();
      const after = line
        .slice(matchedStartIdx + matchedLen)
        .replace(/^[\s)|·,\-–—]+/, '')
        .trim();

      // Layout B: the title/company came on the previous line, dates alone here.
      if (!before && !after && pendingHeader) {
        current = {
          title: pendingHeader.title,
          company: pendingHeader.company,
          startDate: parseDateToken(dateMatch[1]),
          endDate: isCurrent ? null : parseDateToken(endDateRaw),
          isCurrent,
          description: null,
        };
        pendingHeader = null;
        bullets = [];
        continue;
      }
      let title = '';
      let company = '';
      if (before && after) {
        // Common layouts: "Title — Company" or "Company — Title" (heuristic:
        // the side containing a role keyword is the title).
        const beforeHasRole = EMPLOYMENT_KEYWORDS.test(before);
        const afterHasRole = EMPLOYMENT_KEYWORDS.test(after);
        if (beforeHasRole && !afterHasRole) {
          title = before;
          company = after;
        } else if (afterHasRole && !beforeHasRole) {
          company = before;
          title = after;
        } else {
          title = before;
          company = after;
        }
      } else {
        // Layout A: title line above, dates alone on this line, e.g.
        //   "Data Engineer – T-MobileNew York, NY"
        //   "August 2023 – Current"
        const header = before || after;
        if (/^[A-Z][a-z]+ \d{4}$/i.test(header) || /^\d{4}$/.test(header)) {
          title = pendingHeader?.title ?? '';
          company = pendingHeader?.company ?? '';
          pendingHeader = null;
        } else {
          title = header;
        }
      }
      const startDate = parseDateToken(dateMatch[1]);
      // "Title at Company (dates)" layout
      const atSplit = title.split(/\s+at\s+/i);
      if (atSplit.length === 2 && !company) {
        title = atSplit[0].trim();
        company = atSplit[1].trim();
      }
      // "Title - Company" / "Title | Company" / "Title — Company" layout
      if (!company) {
        const sepMatch = title.match(/^(.+?)\s+(?:-|–|—|\|)\s+(.+)$/);
        if (sepMatch) {
          const left = sepMatch[1].trim();
          const right = sepMatch[2].trim();
          const leftHasRole = EMPLOYMENT_KEYWORDS.test(left);
          const rightHasRole = EMPLOYMENT_KEYWORDS.test(right);
          if (rightHasRole && !leftHasRole) {
            company = left;
            title = right;
          } else {
            title = left;
            company = right;
          }
        }
      }
      current = {
        title: title || 'Unknown Title',
        company: company || 'Unknown Company',
        startDate,
        endDate: isCurrent ? null : parseDateToken(endDateRaw),
        isCurrent,
        description: null,
      };
      bullets = [];
      continue;
    }

    if (current) {
      // A title/company header line while inside an entry means the next
      // entry is starting - flush the current one and remember the header.
      const header = looksLikeTitleCompany(line);
      if (header) {
        current.description = bullets.length > 0 ? bullets.join('\n') : null;
        results.push(current);
        current = null;
        pendingHeader = header;
        bullets = [];
        continue;
      }
      // Bullet/content lines become the description.
      if (line.length > 15 && bullets.length < 8) bullets.push(line);
    } else {
      // No date line seen yet - remember title/company for the Layout B case
      // where the date line follows the title line.
      pendingHeader = looksLikeTitleCompany(line);
    }
  }
  if (current) {
    current.description = bullets.length > 0 ? bullets.join('\n') : null;
    results.push(current);
  }
  return results;
}

// ============================================================================
// Top-level parse
// ============================================================================

export function parseResumeText(text: string): ParsedProfile {
  const lines = cleanLines(text);

  const contact = parseContact(lines);

  // Section splitting
  const sections: SectionMap = {};
  let currentSection: keyof SectionMap | null = null;
  for (const line of lines) {
    const detected = detectSection(line);
    if (detected) {
      currentSection = detected;
      sections[currentSection] = [];
      continue;
    }
    if (currentSection) sections[currentSection]!.push(line);
  }

  const skills = sections.skills ? parseSkillsSection(sections.skills) : [];
  const experience =
    sections.experience && sections.experience.length > 1
      ? parseExperience(sections.experience)
      : [];
  const education =
    sections.education && sections.education.length >= 1
      ? parseEducation(sections.education)
      : [];

  const summary = sections.summary?.join(' ').trim() || null;

  return {
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
    location: contact.location ?? null,
    linkedinUrl: contact.linkedinUrl ?? null,
    githubUrl: contact.githubUrl ?? null,
    portfolioUrl: contact.portfolioUrl ?? null,
    summary,
    skills,
    experience,
    education,
  };
}

// ============================================================================
// Profile import (fill-empty-only semantics)
// ============================================================================

export interface ProfileImportResult {
  profileUpdated: boolean;
  createdProfile: boolean;
  fieldsSet: string[];
  skillsAdded: string[];
  skillsSkippedExisting: number;
  experienceAdded: number;
  educationAdded: number;
}

function isEmpty(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === '';
}

/**
 * Import parsed resume data into the candidate profile. Only fills EMPTY
 * fields - never overwrites candidate-entered data. Creates the profile if
 * it does not exist yet.
 */
export async function importProfileFromResume(
  userId: string,
  parsed: ParsedProfile
): Promise<ProfileImportResult> {
  const result: ProfileImportResult = {
    profileUpdated: false,
    createdProfile: false,
    fieldsSet: [],
    skillsAdded: [],
    skillsSkippedExisting: 0,
    experienceAdded: 0,
    educationAdded: 0,
  };

  const existing = await prisma.candidateProfile.findUnique({ where: { userId } });

  const simpleFields = [
    'firstName', 'lastName', 'email', 'phone', 'location',
    'linkedinUrl', 'githubUrl', 'portfolioUrl', 'summary',
  ] as const;

  if (!existing) {
    const data: Record<string, unknown> = {
      firstName: parsed.firstName ?? 'First',
      lastName: parsed.lastName ?? 'Last',
      email: parsed.email ?? 'unknown@example.com',
    };
    for (const f of simpleFields) {
      const parsedValue = parsed[f] as string | null | undefined;
      if (!isEmpty(parsedValue)) {
        data[f] = parsedValue;
      }
    }
    await prisma.candidateProfile.create({ data: data as any });
    result.createdProfile = true;
    result.profileUpdated = true;
    result.fieldsSet.push(...simpleFields.filter((f) => !isEmpty(parsed[f])));
    if (result.fieldsSet.includes('firstName')) {
      result.fieldsSet = result.fieldsSet.filter((f) => f !== 'firstName' && f !== 'lastName' && f !== 'email');
      result.fieldsSet.unshift('firstName', 'lastName', 'email');
    }
  } else {
    const data: Record<string, unknown> = {};
    for (const f of simpleFields) {
      if (isEmpty((existing as any)[f]) && !isEmpty(parsed[f])) {
        data[f] = parsed[f];
        result.fieldsSet.push(f);
      }
    }
    if (Object.keys(data).length > 0) {
      await prisma.candidateProfile.update({ where: { userId }, data });
      result.profileUpdated = true;
    }
  }

  const profile = await prisma.candidateProfile.findUniqueOrThrow({ where: { userId } });

  // Skills: dedupe case-insensitively against existing skills
  if (parsed.skills.length > 0) {
    const existingSkills = await prisma.skill.findMany({
      where: { candidateProfileId: profile.id },
      select: { name: true },
    });
    const existingNames = new Set(existingSkills.map((s) => s.name.toLowerCase()));
    const toAdd = parsed.skills.filter((s) => !existingNames.has(s.toLowerCase()));
    result.skillsSkippedExisting = parsed.skills.length - toAdd.length;
    if (toAdd.length > 0) {
      await prisma.skill.createMany({
        data: toAdd.map((name) => ({ candidateProfileId: profile.id, name })),
      });
      result.skillsAdded = toAdd;
    }
  }

  // Experience: only add if the user has none with the same company+title
  for (const exp of parsed.experience.slice(0, 10)) {
    const dup = await prisma.experience.findFirst({
      where: {
        candidateProfileId: profile.id,
        title: { equals: exp.title },
        company: { equals: exp.company },
      },
    });
    if (dup) continue;
    const startDate = exp.startDate ? new Date(`${exp.startDate}-01`).toISOString() : new Date('2000-01-01').toISOString();
    const endDate = exp.endDate ? new Date(`${exp.endDate}-01`).toISOString() : null;
    await prisma.experience.create({
      data: {
        candidateProfileId: profile.id,
        company: exp.company,
        title: exp.title,
        employmentType: 'FULL_TIME',
        startDate,
        endDate,
        isCurrent: exp.isCurrent,
        description: exp.description,
      },
    });
    result.experienceAdded += 1;
  }

  // Education: dedupe on institution+degree
  for (const edu of parsed.education.slice(0, 5)) {
    const dup = await prisma.education.findFirst({
      where: {
        candidateProfileId: profile.id,
        institution: { equals: edu.institution },
        degree: { equals: edu.degree },
      },
    });
    if (dup) continue;
    const startDate = edu.startDate ? new Date(`${edu.startDate}-01`).toISOString() : new Date('2000-01-01').toISOString();
    const endDate = edu.endDate ? new Date(`${edu.endDate}-01`).toISOString() : null;
    await prisma.education.create({
      data: {
        candidateProfileId: profile.id,
        institution: edu.institution,
        degree: edu.degree,
        fieldOfStudy: edu.fieldOfStudy,
        startDate,
        endDate,
      },
    });
    result.educationAdded += 1;
  }

  return result;
}

// ============================================================================
// Orchestration: parse a stored resume version and persist results
// ============================================================================

/**
 * Parse the file behind a Resume (latest version), store the extracted
 * text + parsed data on the ResumeVersion, and import into the profile
 * with fill-empty-only semantics.
 */
export async function parseAndImportResume(
  userId: string,
  resumeId: string
): Promise<{ parsed: ParsedProfile; importResult: ProfileImportResult }> {
  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
    include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
  });
  if (!resume || resume.userId !== userId) {
    throw new Error('RESUME_NOT_FOUND: Resume not found');
  }

  const version = resume.versions[0];
  if (!version) {
    throw new Error('RESUME_VERSION_NOT_FOUND: Resume has no versions');
  }

  const buffer = await import('fs/promises').then((fs) => fs.readFile(version.filePath));
  const text = await extractResumeText(buffer, resume.mimeType);
  const parsed = parseResumeText(text);

  await prisma.resumeVersion.update({
    where: { id: version.id },
    data: {
      extractedText: text,
      parsedData: parsed as any,
    },
  });

  const importResult = await importProfileFromResume(userId, parsed);
  return { parsed, importResult };
}

# Job Application Agent

A production-oriented SaaS job application automation platform. Discover jobs, analyze descriptions, match candidates, tailor resumes, prepare applications, and automate ATS workflows.

## Vision

This project aims to build an original job application automation platform similar to Tsenta, but with our own implementation based on publicly observable functionality and standard open-source technologies.

## V0.1 Scope

- Candidate profile management
- Resume upload and parsing (PDF, DOCX)
- Job URL ingestion and extraction
- Hybrid job matching engine
- Playwright-based browser automation
- Greenhouse ATS integration (adapter pattern)
- Application form inspection and field detection
- AI-powered question answering with grounding
- Resume tailoring
- Human-in-the-loop review workflow
- BullMQ background job processing
- PostgreSQL + Prisma ORM
- Next.js frontend with shadcn/ui
- TypeScript throughout
- Docker Compose for local development

## Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0 (or yarn/pnpm)
- Docker Desktop or Docker daemon running
- Git

## Project Structure

```
job-application-agent/
├── apps/
│   ├── web/              # Next.js frontend
│   ├── api/              # REST API backend
│   └── worker/           # BullMQ background workers
├── packages/
│   ├── database/         # Prisma ORM & migrations
│   ├── ai/               # AI provider abstraction
│   ├── browser/          # Playwright browser service
│   ├── ats/              # ATS adapter interface & registry
│   ├── core/             # Core business logic
│   ├── greenhouse/       # Greenhouse adapter implementation
│   ├── resume/           # Resume parsing & tailoring
│   ├── matching/         # Matching engine
│   └── shared/           # Shared types & utilities
├── infrastructure/
│   └── docker/           # Docker configuration
├── docker-compose.yml    # Local development environment
├── .env.example          # Environment variable template
└── README.md             # This file
```

## Quick Start

### 1. Clone & Install

```bash
git clone <repository>
cd job-application-agent
cp .env.example .env
npm install
```

### 2. Start Infrastructure

```bash
docker compose up -d
docker compose logs -f postgres redis
```

Wait for both services to be healthy:
- PostgreSQL: "pg_isready" passes
- Redis: "redis-cli ping" returns "PONG"

### 3. Initialize Database

```bash
npm run db:migrate
npm run db:seed
npm run db:generate
```

### 4. Run Development Servers

In separate terminals:

```bash
# Terminal 1: Frontend
npm run dev:web

# Terminal 2: API
npm run dev:api

# Terminal 3: Workers
npm run dev:worker
```

Or run all together:

```bash
npm run dev
```

### 5. Access Application

- Frontend: http://localhost:4000
- API: http://localhost:4001
- Prisma Studio: `npm run db:studio` → http://localhost:5555

## Environment Variables

See `.env.example` for all available options. Key variables:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/jaa_dev

# Redis
REDIS_URL=redis://localhost:6379

# AI Provider (openai, anthropic, gemini, groq)
AI_PROVIDER=openai
AI_MODEL=gpt-4-turbo-preview
OPENAI_API_KEY=sk_...

# Browser
BROWSER_HEADLESS=true

# Application
NODE_ENV=development
```

## Development Scripts

### Workspace Management

```bash
npm run build              # Build all packages
npm run lint               # Lint all packages
npm run type-check         # TypeScript check all packages
npm run test               # Run tests all packages
npm run test:e2e           # Run E2E tests
```

### Database

```bash
npm run db:migrate         # Run pending migrations
npm run db:generate        # Generate Prisma client
npm run db:seed            # Seed database with test data
npm run db:push            # Push schema without migrations
npm run db:studio          # Open Prisma Studio GUI
```

### Docker

```bash
docker compose up -d       # Start services in background
docker compose down        # Stop and remove services
docker compose logs -f     # Stream logs
docker compose ps          # Show status
```

### Development

```bash
npm run dev                # Start all services (web, api, worker)
npm run dev:web            # Start frontend only
npm run dev:api            # Start API only
npm run dev:worker         # Start workers only
```

## Architecture

### Technology Stack

**Frontend:**
- Next.js 14+ (React, TypeScript)
- Tailwind CSS
- shadcn/ui components
- TanStack Query for data fetching
- Zustand for state management

**Backend:**
- Node.js + Express (TypeScript)
- PostgreSQL + Prisma ORM
- Redis for caching and job queue
- BullMQ for background jobs

**Browser Automation:**
- Playwright
- Chromium browser

**AI:**
- Pluggable provider (OpenAI, Anthropic, Gemini, Groq)
- Structured output with validation
- Grounding and confidence scoring

**ATS Integration:**
- Adapter pattern for extensibility
- Greenhouse as first implementation
- Generic form inspection engine

### Design Principles

1. **Clean Architecture:** Clear separation between UI, API, workers, and infrastructure
2. **Extensibility:** ATS adapters follow a common interface; AI providers are pluggable
3. **Security First:** Environment variables for secrets; no credentials in code; input validation
4. **Observability:** Structured logging with application/job/user context
5. **Type Safety:** Strong TypeScript throughout
6. **Testing:** Unit tests for critical logic; mock pages for browser tests
7. **Human-in-the-Loop:** V0.1 requires explicit approval before submission

## Database Schema (PHASE 2)

### Core Models

**User**
- Email (unique)
- Name
- Timestamps

**CandidateProfile**
- One-to-one relationship with User
- Personal info (name, email, phone, location)
- Work preferences (mode, locations, roles, salary)
- Authorization status
- Skills array
- Education and Experience relationships

**Education**
- Institution, degree, field of study
- Dates, GPA
- Linked to CandidateProfile

**Experience**
- Company, title, location
- Employment type
- Start/end dates, currently working flag
- Description
- Linked to CandidateProfile

**Skill**
- Name (unique per candidate)
- Category, proficiency level
- Years of experience
- Linked to CandidateProfile

**Resume**
- Multiple resumes per user
- File metadata (name, type, size, MIME)
- Storage key (for S3/R2/local storage)
- Default flag
- Version history relationship

**ResumeVersion**
- Version numbering
- Source (ORIGINAL, TAILORED, USER_EDITED, AI_GENERATED)
- Extracted text and parsed data (JSON)
- Change summary

**Job**
- External ID and ATS identifier
- Company, title, location
- Description, requirements, responsibilities
- Employment type, work mode
- Salary range
- Posted/discovered dates

**JobMatch**
- Unique per user-job pair
- Match score (0-100)
- Component scores (skills, experience, education, location, authorization, role)
- Strengths, gaps, warnings
- Explanation

**Application**
- State machine status enum
- ATS type and external application ID
- Resume version used
- Timestamps (started, submitted, attempted, failed, etc.)
- Error tracking

**ApplicationQuestion**
- Question label and normalized label
- Field type (TEXT, EMAIL, PHONE, TEXTAREA, SELECT, RADIO, CHECKBOX, FILE, DATE, NUMBER, UNKNOWN)
- Required flag
- Options for select/radio/checkbox
- Mapped source and confidence
- Located on application form

**ApplicationAnswer**
- Answer text
- Source (PROFILE, RESUME, USER_INPUT, AI, SYSTEM)
- Confidence score (0-1)
- Grounded facts (where answer came from)
- Needs review flag
- Approval flag

**ApplicationEvent**
- Audit trail for application lifecycle
- Event type enum (APPLICATION_CREATED, FORM_INSPECTED, ANSWER_GENERATED, FORM_FILLED, REVIEW_REQUESTED, REVIEW_APPROVED, SUBMISSION_STARTED, SUBMISSION_COMPLETED, FAILED, CAPTCHA_DETECTED, SECURITY_CHALLENGE, etc.)
- Status snapshot
- Metadata (JSON)
- Indexed for query performance

**AutomationRun**
- Browser automation session tracking
- Status (QUEUED, RUNNING, PAUSED, COMPLETED, FAILED, CANCELLED)
- Provider (PLAYWRIGHT)
- Timestamps and error messages
- Metadata for debugging

## REST API Endpoints (PHASE 2)

### Candidate Profile

```
GET    /api/candidate              Get profile
POST   /api/candidate              Create profile
PATCH  /api/candidate              Update profile
```

### Education

```
GET    /api/candidate/education              List all
POST   /api/candidate/education              Create
PATCH  /api/candidate/education/:id          Update
DELETE /api/candidate/education/:id          Delete
```

### Experience

```
GET    /api/candidate/experience              List all
POST   /api/candidate/experience              Create
PATCH  /api/candidate/experience/:id          Update
DELETE /api/candidate/experience/:id          Delete
```

### Skills

```
GET    /api/candidate/skills              List all
POST   /api/candidate/skills              Create
DELETE /api/candidate/skills/:id          Delete
```

### Resumes

```
GET    /api/resumes                List with pagination
GET    /api/resumes/:id            Get with versions
```

### Jobs

```
GET    /api/jobs                   List with pagination
GET    /api/jobs/:id               Get with matches
```

### Applications

```
GET    /api/applications                          List (filtered by status, paginated)
GET    /api/applications/:id                      Get with questions, answers, events
```

## Database Setup & Development

### Running Migrations

```bash
# Create migration from schema changes
npm run db:migrate

# Validate schema
npm run db:validate

# Generate Prisma client
npm run db:generate
```

### Seeding Data

```bash
# Seed with development fixtures
npm run db:seed
```

Seed data includes:
- 1 development user
- 1 candidate profile
- 2 education records
- 3 experience records
- 10 skills
- 2 resumes with versions
- 3 jobs
- 3 job matches
- 2 applications with questions/answers
- 5 application events
- 1 automation run

### Prisma Studio

Open a GUI to browse and edit database:

```bash
npm run db:studio
```

## API Documentation

### Response Format

**Success:**
```json
{ "data": {...} }
```

**Collections with Pagination:**
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100
  }
}
```

**Error:**
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": [...]
  }
}
```

### Authentication (Development)

In PHASE 2, authentication is stubbed with a development user:

```
User ID: dev-user-123 (or DEV_USER_ID environment variable)
```

All API requests are scoped to this user. Real authentication will be implemented in a later phase.

### Request Validation

All endpoints validate request bodies using Zod. Invalid requests return 400 with validation details.

## Performance Considerations

- Indexes on frequently-queried fields (userId, jobId, createdAt, status, etc.)
- Pagination on list endpoints (default 20 items per page, max 100)
- Efficient includes to avoid N+1 queries
- Proper relationships and cascade deletion

## Development Workflow (PHASE 2)

1. **Start infrastructure:**
   ```bash
   docker compose up -d
   ```

2. **Initialize database:**
   ```bash
   npm run db:migrate
   npm run db:seed
   ```

3. **Run API server:**
   ```bash
   npm run dev:api
   ```

4. **Test endpoints:**
   ```bash
   curl http://localhost:4001/api/candidate
   ```

5. **View database:**
   ```bash
   npm run db:studio
   ```



### PHASE 1: Project Scaffold & Docker ✓
- Monorepo structure
- Docker Compose (PostgreSQL, Redis)
- Next.js application
- Backend structure
- Shared packages scaffold
- Environment configuration

### PHASE 2: Database Schema & API ✓
- Prisma schema with 15+ models
- PostgreSQL relationships and migrations
- Seed data with realistic development fixtures
- REST API with CRUD endpoints
- Zod validation for all inputs
- Development authentication (DEV_USER_ID)
- Error handling and logging
- API Response format standardization
- Candidate Profile, Education, Experience, Skills APIs
- Resumes, Jobs, Applications APIs

### PHASE 3: Candidate Profile & Resume (Next)
- Candidate profile management API
- Resume upload (PDF, DOCX)
- Resume parsing and extraction
- Structured candidate representation

### PHASE 4: Job Ingestion
- Job URL validation
- Playwright job extraction
- Structured job storage
- Extensible job parser

### PHASE 5: Matching Engine
- Hybrid matching algorithm
- Skill analysis
- Experience alignment
- Location and remote preferences
- Match scoring and explanation

### PHASE 6: Browser Service
- Playwright lifecycle management
- Page context handling
- Realistic browser behavior
- Error and timeout handling

### PHASE 7: ATS Adapter Interface
- Abstract adapter interface
- Field type definitions
- Application session model
- Adapter registry

### PHASE 8: Greenhouse Adapter
- Greenhouse detection
- Job extraction
- Application form inspection
- Field mapping
- Application filling

### PHASE 9: Form Inspection
- Generic form parser
- Field type detection
- Required field identification
- Field locator strategy

### PHASE 10: Field Mapping
- Deterministic mapping rules
- Candidate profile → form fields
- Resume file handling
- Confidence scoring

### PHASE 11: AI Question Answering
- Grounded answer generation
- Confidence scoring
- Fact checking
- Human review flagging

### PHASE 12: Resume Tailoring
- Keyword optimization
- Experience reordering
- Bullet point emphasis
- Summary customization
- Version history

### PHASE 13: Human Review UI
- Application preview
- Answer review
- Confidence visualization
- Approval workflow

### PHASE 14: BullMQ Worker
- Job queue setup
- Retry policies
- Idempotency
- Status tracking

### PHASE 15: End-to-End Mock Test
- Mock Greenhouse page
- Full workflow test
- Validation and assertions

## Security

- All secrets in environment variables
- No hardcoded credentials
- Input validation on all endpoints
- SQL injection prevention (Prisma)
- CSRF protection (Next.js built-in)
- Rate limiting (to implement in Phase 2)
- Audit logging for all state changes
- Data isolation per user

## Testing

Run tests:

```bash
npm run test
```

Test coverage includes:

- Unit tests for business logic
- Integration tests with real database
- Browser automation tests with mock pages
- E2E tests for critical workflows

## Troubleshooting

### Docker Issues

```bash
# Check services are running
docker compose ps

# View logs
docker compose logs postgres
docker compose logs redis

# Restart services
docker compose restart
```

### Database Issues

```bash
# Reset database (WARNING: deletes data)
npm run db:push
npm run db:seed

# View database in GUI
npm run db:studio
```

### Build Issues

```bash
# Clear node_modules and reinstall
rm -rf node_modules
npm install

# Rebuild packages
npm run build
```

## Contributing

1. Create a feature branch from `main`
2. Follow TypeScript strict mode
3. Add tests for new logic
4. Run `npm run type-check` and `npm run lint` before committing
5. Use clear, descriptive commit messages

## License

(To be determined)

## Support

For issues, questions, or discussions, please open an issue on GitHub.

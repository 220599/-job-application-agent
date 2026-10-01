import type {
  CandidateProfile,
  CandidateProfileCreate,
  CandidateProfileUpdate,
  Education,
  EducationCreate,
  EducationUpdate,
  Experience,
  ExperienceCreate,
  ExperienceUpdate,
  Skill,
  Resume,
  ResumeCreate,
  ResumeVersion,
  Job,
  JobCreate,
  JobMatchSummary,
} from '@jaa/shared';

export interface ResumeImportSummary {
  profileUpdated: boolean;
  createdProfile: boolean;
  fieldsSet: string[];
  skillsAdded: string[];
  skillsSkippedExisting: number;
  experienceAdded: number;
  educationAdded: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4001';

class ApiError extends Error {
  constructor(
    public status: number,
    public message: string,
    public details?: any[]
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  if (!response.ok) {
    let errorData: { error?: { code: string; message: string; details?: any[] } };
    try {
      errorData = await response.json();
    } catch {
      errorData = {};
    }

    throw new ApiError(
      response.status,
      errorData.error?.message || 'An error occurred',
      errorData.error?.details
    );
  }

  const json = await response.json();
  // Return the raw response body (e.g. `{ data: X }` or `{ data: X[], pagination }`)
  return json as T;
}

// Candidate Profile APIs
export const candidateApi = {
  get: () => fetchApi<{ data: CandidateProfile }>('/api/candidate'),
  create: (data: CandidateProfileCreate) =>
    fetchApi<{ data: CandidateProfile }>('/api/candidate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (data: CandidateProfileUpdate) =>
    fetchApi<{ data: CandidateProfile }>('/api/candidate', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};

// Education APIs
export const educationApi = {
  list: () => fetchApi<{ data: Education[] }>('/api/candidate/education'),
  create: (data: EducationCreate) =>
    fetchApi<{ data: Education }>('/api/candidate/education', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: EducationUpdate) =>
    fetchApi<{ data: Education }>(`/api/candidate/education/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<{ data: { id: string } }>(`/api/candidate/education/${id}`, {
      method: 'DELETE',
    }),
};

// Experience APIs
export const experienceApi = {
  list: () => fetchApi<{ data: Experience[] }>('/api/candidate/experience'),
  create: (data: ExperienceCreate) =>
    fetchApi<{ data: Experience }>('/api/candidate/experience', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: ExperienceUpdate) =>
    fetchApi<{ data: Experience }>(`/api/candidate/experience/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<{ data: { id: string } }>(`/api/candidate/experience/${id}`, {
      method: 'DELETE',
    }),
};

// Skills APIs
export const skillsApi = {
  list: () => fetchApi<{ data: Skill[] }>('/api/candidate/skills'),
  create: (data: { name: string; category?: string; proficiency?: string; yearsOfExperience?: number }) =>
    fetchApi<{ data: Skill }>('/api/candidate/skills', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<{ data: { id: string } }>(`/api/candidate/skills/${id}`, {
      method: 'DELETE',
    }),
};

// Resume APIs
export const resumeApi = {
  list: (page = 1, pageSize = 10) =>
    fetchApi<{
      data: Resume[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/api/resumes?page=${page}&pageSize=${pageSize}`),
  get: (id: string) => fetchApi<{ data: Resume }>(`/api/resumes/${id}`),
  upload: async (
    file: File,
    name: string
  ): Promise<{ data: Resume; importSummary: ResumeImportSummary | null }> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);

    const response = await fetch(`${API_BASE}/api/resumes`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      let errorData: { error?: { code: string; message: string; details?: any[] } };
      try {
      errorData = await response.json();
      } catch {
        errorData = {};
      }

      throw new ApiError(
        response.status,
        errorData.error?.message || 'Upload failed',
        errorData.error?.details
      );
    }

    const json = await response.json();
    return { data: json.data, importSummary: json.importSummary ?? null };
  },
  reimport: (id: string) =>
    fetchApi<{ data: { parsed: unknown; importResult: ResumeImportSummary } }>(
      `/api/resumes/${id}/reimport`,
      { method: 'POST' }
    ),
  setDefault: (id: string) =>
    fetchApi<{ data: Resume }>(`/api/resumes/${id}/set-default`, {
      method: 'PATCH',
    }),
  delete: (id: string) =>
    fetchApi<{ data: { id: string } }>(`/api/resumes/${id}`, {
      method: 'DELETE',
    }),
  getVersion: (id: string) =>
    fetchApi<{ data: ResumeVersion[] }>(`/api/resumes/${id}/versions`),
};

// Job APIs
export type JobSortBy = 'discoveredAt' | 'matchScore';

export const jobsApi = {
  list: (page = 1, pageSize = 10, sortBy: JobSortBy = 'discoveredAt') =>
    fetchApi<{
      data: Job[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/api/jobs?page=${page}&pageSize=${pageSize}&sortBy=${sortBy}`),
  get: (id: string) => fetchApi<{ data: Job }>(`/api/jobs/${id}`),
  create: (url: string) =>
    fetchApi<{ data: Job }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  // Matching (Phase 5)
  calculateMatch: (jobId: string) =>
    fetchApi<{ data: JobMatchSummary }>(`/api/jobs/${jobId}/match`, {
      method: 'POST',
    }),
  getMatch: (jobId: string) =>
    fetchApi<{ data: JobMatchSummary }>(`/api/jobs/${jobId}/match`),
};
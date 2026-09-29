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
} from '@jaa/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

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
): Promise<{ data: T }> {
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
  return json as { data: T };
}

// Candidate Profile APIs
export const candidateApi = {
  get: () => fetchApi<CandidateProfile>('/api/candidate'),
  create: (data: CandidateProfileCreate) =>
    fetchApi<CandidateProfile>('/api/candidate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (data: CandidateProfileUpdate) =>
    fetchApi<CandidateProfile>('/api/candidate', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};

// Education APIs
export const educationApi = {
  list: () => fetchApi<Education[]>('/api/candidate/education'),
  create: (data: EducationCreate) =>
    fetchApi<Education>('/api/candidate/education', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: EducationUpdate) =>
    fetchApi<Education>(`/api/candidate/education/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<{ id: string }>(`/api/candidate/education/${id}`, {
      method: 'DELETE',
    }),
};

// Experience APIs
export const experienceApi = {
  list: () => fetchApi<Experience[]>('/api/candidate/experience'),
  create: (data: ExperienceCreate) =>
    fetchApi<Experience>('/api/candidate/experience', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: ExperienceUpdate) =>
    fetchApi<Experience>(`/api/candidate/experience/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<{ id: string }>(`/api/candidate/experience/${id}`, {
      method: 'DELETE',
    }),
};

// Skills APIs
export const skillsApi = {
  list: () => fetchApi<Skill[]>('/api/candidate/skills'),
  create: (data: { name: string; category?: string; proficiency?: string; yearsOfExperience?: number }) =>
    fetchApi<Skill>('/api/candidate/skills', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<{ id: string }>(`/api/candidate/skills/${id}`, {
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
  get: (id: string) => fetchApi<Resume>(`/api/resumes/${id}`),
  upload: async (file: File, name: string) => {
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

    return response.json();
  },
  setDefault: (id: string) =>
    fetchApi<Resume>(`/api/resumes/${id}/set-default`, {
      method: 'PATCH',
    }),
  delete: (id: string) =>
    fetchApi<{ id: string }>(`/api/resumes/${id}`, {
      method: 'DELETE',
    }),
  getVersion: (id: string) =>
    fetchApi<ResumeVersion[]>(`/api/resumes/${id}/versions`),
};
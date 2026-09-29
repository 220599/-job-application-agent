'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { experienceApi } from '@/lib/api';
import type { ExperienceUpdate } from '@jaa/shared';
import { z } from 'zod';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Input,
  Label,
  Textarea,
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui';

const experienceSchema = z.object({
  company: z.string().min(1, 'Company is required'),
  title: z.string().min(1, 'Title is required'),
  location: z.string().optional(),
  employmentType: z.string().optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  isCurrent: z.boolean().optional(),
  description: z.string().optional(),
});

type ExperienceFormData = z.infer<typeof experienceSchema>;

interface ExperienceSectionProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

export function ExperienceSection({ profile, onSuccess, onError }: ExperienceSectionProps) {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingExperience, setEditingExperience] = useState<any>(null);
  const [formData, setFormData] = useState<ExperienceFormData>({
    company: '',
    title: '',
    location: '',
    employmentType: 'FULL_TIME',
    startDate: new Date(),
    endDate: undefined,
    isCurrent: false,
    description: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const createMutation = useMutation({
    mutationFn: (data: ExperienceFormData) => experienceApi.create(data as any),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      setShowDialog(false);
      setFormData({
        company: '',
        title: '',
        location: '',
        employmentType: 'FULL_TIME',
        startDate: new Date(),
        endDate: undefined,
        isCurrent: false,
        description: '',
      });
      onSuccess('Experience added successfully');
    },
    onError: (err: any) => onError(err),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ExperienceFormData }) =>
      experienceApi.update(id, data as ExperienceUpdate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      setShowDialog(false);
      setFormData({
        company: '',
        title: '',
        location: '',
        employmentType: 'FULL_TIME',
        startDate: new Date(),
        endDate: undefined,
        isCurrent: false,
        description: '',
      });
      setEditingExperience(null);
      onSuccess('Experience updated successfully');
    },
    onError: (err: any) => onError(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => experienceApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      onSuccess('Experience deleted successfully');
    },
    onError: (err: any) => onError(err),
  });

  const experienceList = profile?.experience || [];

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this experience record?')) {
      deleteMutation.mutate(id);
    }
  };

  const handleEdit = (exp: any) => {
    setEditingExperience(exp);
    setFormData({
      company: exp.company || '',
      title: exp.title || '',
      location: exp.location || '',
      employmentType: exp.employmentType || 'FULL_TIME',
      startDate: new Date(exp.startDate),
      endDate: exp.endDate ? new Date(exp.endDate) : undefined,
      isCurrent: exp.isCurrent || false,
      description: exp.description || '',
    });
    setShowDialog(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors: Record<string, string> = {};

    if (!formData.company.trim()) validationErrors.company = 'Company is required';
    if (!formData.title.trim()) validationErrors.title = 'Title is required';

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});

    if (editingExperience) {
      updateMutation.mutate({ id: editingExperience.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleCancel = () => {
    setShowDialog(false);
    setFormData({
      company: '',
      title: '',
      location: '',
      employmentType: 'FULL_TIME',
      startDate: new Date(),
      endDate: undefined,
      isCurrent: false,
      description: '',
    });
    setEditingExperience(null);
    setErrors({});
  };

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
  };

  const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'FREELANCE'];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Experience</CardTitle>
        <CardDescription>
          Your professional work history
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDialog(true)}
          className="mb-4"
        >
          Add Experience
        </Button>

        {experienceList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No experience records added yet.
          </p>
        ) : (
          <div className="space-y-4">
            {experienceList.map((exp: any) => (
              <div key={exp.id} className="rounded-lg border p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="font-medium">{exp.title} at {exp.company}</h4>
                    {exp.location && (
                      <p className="text-sm text-muted-foreground">{exp.location}</p>
                    )}
                    <p className="text-sm text-muted-foreground">
                      {formatDate(exp.startDate)} -{' '}
                      {exp.isCurrent ? 'Present' : exp.endDate ? formatDate(exp.endDate) : 'Present'}
                      {exp.employmentType && ` \u00B7 ${exp.employmentType.replace('_', ' ')}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(exp)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(exp.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {exp.description && (
                  <p className="mt-2 text-sm text-muted-foreground">{exp.description}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add/Edit Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editingExperience ? 'Edit Experience' : 'Add Experience'}
              </DialogTitle>
              <DialogDescription>
                {editingExperience
                  ? 'Update your experience details'
                  : 'Add a new experience record'}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="company">Company *</Label>
                <Input
                  id="company"
                  value={formData.company}
                  onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className={errors.company ? 'border-destructive' : ''}
                />
                {errors.company && (
                  <p className="text-sm text-destructive">{errors.company}</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className={errors.title ? 'border-destructive' : ''}
                />
                {errors.title && (
                  <p className="text-sm text-destructive">{errors.title}</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="location">Location (optional)</Label>
                <Input
                  id="location"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  placeholder="City, State"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="employmentType">Employment Type</Label>
                <select
                  id="employmentType"
                  value={formData.employmentType}
                  onChange={(e) => setFormData({ ...formData, employmentType: e.target.value })}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={formData.startDate.toISOString().split('T')[0]}
                  onChange={(e) => setFormData({ ...formData, startDate: new Date(e.target.value) })}
                  disabled={createMutation.isPending || updateMutation.isPending}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="endDate">End Date (optional)</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={formData.endDate ? formData.endDate.toISOString().split('T')[0] : ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      endDate: e.target.value ? new Date(e.target.value) : undefined,
                    })
                  }
                  disabled={createMutation.isPending || updateMutation.isPending}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty if currently working here
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="isCurrent">Currently working here</Label>
                <div className="flex items-center gap-2">
                  <input
                    id="isCurrent"
                    type="checkbox"
                    checked={formData.isCurrent}
                    onChange={(e) => setFormData({ ...formData, isCurrent: e.target.checked })}
                    disabled={createMutation.isPending || updateMutation.isPending}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <label htmlFor="isCurrent" className="text-sm font-normal text-muted-foreground">
                    I currently work here
                  </label>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="description">Description (optional)</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  placeholder="Describe your role, achievements, and technologies used..."
                  rows={4}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingExperience ? 'Update' : 'Add'} Experience
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
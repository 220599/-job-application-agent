'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { educationApi } from '@/lib/api';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import { Button, Input, Label, Textarea, Badge, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui';

const educationSchema = z.object({
  institution: z.string().min(1, 'Institution is required'),
  degree: z.string().min(1, 'Degree is required'),
  fieldOfStudy: z.string().min(1, 'Field of study is required'),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  gpa: z.number().min(0).max(4.5).optional(),
  description: z.string().optional(),
});

type EducationFormData = z.infer<typeof educationSchema>;

interface EducationSectionProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

export function EducationSection({ profile, onSuccess, onError }: EducationSectionProps) {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingEducation, setEditingEducation] = useState<any>(null);
  const [formData, setFormData] = useState<EducationFormData>({
    institution: '',
    degree: '',
    fieldOfStudy: '',
    startDate: new Date(),
    endDate: undefined,
    gpa: undefined,
    description: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const createMutation = useMutation({
    mutationFn: (data: EducationFormData) => educationApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      setShowDialog(false);
      setFormData({
        institution: '',
        degree: '',
        fieldOfStudy: '',
        startDate: new Date(),
        endDate: undefined,
        gpa: undefined,
        description: '',
      });
      onSuccess('Education added successfully');
    },
    onError: (err: any) => onError(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => educationApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      onSuccess('Education deleted successfully');
    },
    onError: (err: any) => onError(err),
  });

  const educationList = profile?.education || [];

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this education record?')) {
      deleteMutation.mutate(id);
    }
  };

  const handleEdit = (edu: any) => {
    setEditingEducation(edu);
    setFormData({
      institution: edu.institution || '',
      degree: edu.degree || '',
      fieldOfStudy: edu.fieldOfStudy || '',
      startDate: new Date(edu.startDate),
      endDate: edu.endDate ? new Date(edu.endDate) : undefined,
      gpa: edu.gpa || undefined,
      description: edu.description || '',
    });
    setShowDialog(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors: Record<string, string> = {};

    if (!formData.institution.trim()) validationErrors.institution = 'Institution is required';
    if (!formData.degree.trim()) validationErrors.degree = 'Degree is required';
    if (!formData.fieldOfStudy.trim()) validationErrors.fieldOfStudy = 'Field of study is required';

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});

    if (editingEducation) {
      try {
        await educationApi.update(editingEducation.id, formData);
        queryClient.invalidateQueries({ queryKey: ['candidate'] });
        setShowDialog(false);
        setFormData({
          institution: '',
          degree: '',
          fieldOfStudy: '',
          startDate: new Date(),
          endDate: undefined,
          gpa: undefined,
          description: '',
        });
        setEditingEducation(null);
        onSuccess('Education updated successfully');
      } catch (err: any) {
        onError(err);
      }
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleCancel = () => {
    setShowDialog(false);
    setFormData({
      institution: '',
      degree: '',
      fieldOfStudy: '',
      startDate: new Date(),
      endDate: undefined,
      gpa: undefined,
      description: '',
    });
    setEditingEducation(null);
    setErrors({});
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
  };

  const isCurrent = () => {
    if (!editingEducation?.endDate && editingEducation?.startDate) {
      return true;
    }
    return false;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Education</CardTitle>
        <CardDescription>
          Your academic background and qualifications
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDialog(true)}
          className="mb-4"
        >
          Add Education
        </Button>

        {educationList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No education records added yet.
          </p>
        ) : (
          <div className="space-y-4">
            {educationList.map((edu: any) => (
              <div key={edu.id} className="rounded-lg border p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="font-medium">{edu.institution}</h4>
                    <p className="text-sm text-muted-foreground">
                      {edu.degree} in {edu.fieldOfStudy}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {formatDate(new Date(edu.startDate))} -{' '}
                      {edu.endDate ? formatDate(new Date(edu.endDate)) : 'Current'}
                    </p>
                    {edu.gpa && (
                      <p className="text-sm text-muted-foreground">GPA: {edu.gpa}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(edu)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(edu.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {edu.description && (
                  <p className="mt-2 text-sm text-muted-foreground">{edu.description}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add/Edit Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingEducation ? 'Edit Education' : 'Add Education'}
              </DialogTitle>
              <DialogDescription>
                {editingEducation
                  ? 'Update your education details'
                  : 'Add a new education record'}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="institution">Institution *</Label>
                <Input
                  id="institution"
                  value={formData.institution}
                  onChange={(e) => setFormData({ ...formData, institution: e.target.value })}
                  disabled={createMutation.isPending}
                  className={errors.institution ? 'border-destructive' : ''}
                />
                {errors.institution && (
                  <p className="text-sm text-destructive">{errors.institution}</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="degree">Degree *</Label>
                <Input
                  id="degree"
                  value={formData.degree}
                  onChange={(e) => setFormData({ ...formData, degree: e.target.value })}
                  disabled={createMutation.isPending}
                  className={errors.degree ? 'border-destructive' : ''}
                />
                {errors.degree && (
                  <p className="text-sm text-destructive">{errors.degree}</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="fieldOfStudy">Field of Study *</Label>
                <Input
                  id="fieldOfStudy"
                  value={formData.fieldOfStudy}
                  onChange={(e) => setFormData({ ...formData, fieldOfStudy: e.target.value })}
                  disabled={createMutation.isPending}
                  className={errors.fieldOfStudy ? 'border-destructive' : ''}
                />
                {errors.fieldOfStudy && (
                  <p className="text-sm text-destructive">{errors.fieldOfStudy}</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={formData.startDate.toISOString().split('T')[0]}
                  onChange={(e) => setFormData({ ...formData, startDate: new Date(e.target.value) })}
                  disabled={createMutation.isPending}
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
                  disabled={createMutation.isPending}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty if currently studying
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="gpa">GPA (optional)</Label>
                <Input
                  id="gpa"
                  type="number"
                  step="0.01"
                  min="0"
                  max="4.5"
                  value={formData.gpa ?? ''}
                  onChange={(e) => setFormData({ ...formData, gpa: e.target.value ? Number(e.target.value) : undefined })}
                  disabled={createMutation.isPending}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="description">Description (optional)</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  disabled={createMutation.isPending}
                  placeholder="Additional notes or achievements..."
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {editingEducation ? 'Update' : 'Add'} Education
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
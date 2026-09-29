'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { skillsApi } from '@/lib/api';
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
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui';

const skillSchema = z.object({
  name: z.string().min(1, 'Skill name is required'),
  category: z.string().optional(),
  proficiency: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT']).optional(),
  yearsOfExperience: z.number().min(0).max(50).optional(),
});

type SkillFormData = z.infer<typeof skillSchema>;

interface SkillsSectionProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

export function SkillsSection({ profile, onSuccess, onError }: SkillsSectionProps) {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [formData, setFormData] = useState<SkillFormData>({
    name: '',
    category: '',
    proficiency: 'INTERMEDIATE',
    yearsOfExperience: undefined,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const createMutation = useMutation({
    mutationFn: (data: SkillFormData) =>
      skillsApi.create({
        name: data.name,
        category: data.category,
        proficiency: data.proficiency,
        yearsOfExperience: data.yearsOfExperience,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      setShowDialog(false);
      setFormData({
        name: '',
        category: '',
        proficiency: 'INTERMEDIATE',
        yearsOfExperience: undefined,
      });
      onSuccess('Skill added successfully');
    },
    onError: (err: any) => onError(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => skillsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      onSuccess('Skill deleted successfully');
    },
    onError: (err: any) => onError(err),
  });

  const skillsList = profile?.skills || [];

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this skill?')) {
      deleteMutation.mutate(id);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors: Record<string, string> = {};

    if (!formData.name.trim()) validationErrors.name = 'Skill name is required';

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    createMutation.mutate(formData);
  };

  const handleCancel = () => {
    setShowDialog(false);
    setFormData({
      name: '',
      category: '',
      proficiency: 'INTERMEDIATE',
      yearsOfExperience: undefined,
    });
    setErrors({});
  };

  const PROFICIENCY_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'] as const;

  const getProficiencyColor = (proficiency: string) => {
    switch (proficiency) {
      case 'BEGINNER':
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
      case 'INTERMEDIATE':
        return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
      case 'ADVANCED':
        return 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300';
      case 'EXPERT':
        return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>
          Your technical and professional skills
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDialog(true)}
          className="mb-4"
        >
          Add Skill
        </Button>

        {skillsList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No skills added yet. Add your first skill to get started.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {skillsList.map((skill: any) => (
              <Badge
                key={skill.id}
                variant="secondary"
                className={`${getProficiencyColor(skill.proficiency)} gap-1`}
              >
                {skill.name}
                {skill.category && (
                  <span className="text-xs opacity-70">{skill.category}</span>
                )}
                {skill.proficiency && (
                  <span className="text-xs opacity-70">{skill.proficiency}</span>
                )}
                {skill.yearsOfExperience !== undefined && skill.yearsOfExperience !== null && (
                  <span className="text-xs opacity-70">{skill.yearsOfExperience} yr</span>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(skill.id)}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted/50"
                  aria-label={`Delete ${skill.name}`}
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </Badge>
            ))}
          </div>
        )}

        {/* Add Skill Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Skill</DialogTitle>
              <DialogDescription>
                Add a new skill to your profile
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Skill Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  disabled={createMutation.isPending}
                  className={errors.name ? 'border-destructive' : ''}
                  placeholder="e.g., React, Python, Project Management"
                />
                {errors.name && (
                  <p className="text-sm text-destructive">{errors.name}</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="category">Category (optional)</Label>
                <Input
                  id="category"
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  disabled={createMutation.isPending}
                  placeholder="e.g., Frontend, Backend, DevOps, Soft Skills"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="proficiency">Proficiency</Label>
                <select
                  id="proficiency"
                  value={formData.proficiency}
                  onChange={(e) => setFormData({ ...formData, proficiency: e.target.value as any })}
                  disabled={createMutation.isPending}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {PROFICIENCY_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level.charAt(0) + level.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="yearsOfExperience">Years of Experience (optional)</Label>
                <Input
                  id="yearsOfExperience"
                  type="number"
                  step="0.5"
                  min="0"
                  max="50"
                  value={formData.yearsOfExperience ?? ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      yearsOfExperience: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  disabled={createMutation.isPending}
                  placeholder="e.g., 3.5"
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  Add Skill
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
'use client';

import { useState } from 'react';
import { candidateApi } from '@/lib/api';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import { Input, Label, Button } from '@/components/ui';

const linksSchema = z.object({
  linkedinUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  githubUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  portfolioUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  websiteUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
});

type LinksFormData = z.infer<typeof linksSchema>;

interface ProfessionalLinksFormProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

export function ProfessionalLinksForm({ profile, onSuccess, onError }: ProfessionalLinksFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<LinksFormData>({
    linkedinUrl: profile?.linkedinUrl || '',
    githubUrl: profile?.githubUrl || '',
    portfolioUrl: profile?.portfolioUrl || '',
    websiteUrl: profile?.websiteUrl || '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (data: LinksFormData): Record<string, string> => {
    const errors: Record<string, string> = {};
    const urlRegex = /^https?:\/\/.+$/;
    if (data.linkedinUrl && !urlRegex.test(data.linkedinUrl)) errors.linkedinUrl = 'Must be a valid URL';
    if (data.githubUrl && !urlRegex.test(data.githubUrl)) errors.githubUrl = 'Must be a valid URL';
    if (data.portfolioUrl && !urlRegex.test(data.portfolioUrl)) errors.portfolioUrl = 'Must be a valid URL';
    if (data.websiteUrl && !urlRegex.test(data.websiteUrl)) errors.websiteUrl = 'Must be a valid URL';
    return errors;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors = validate(formData);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    try {
      await candidateApi.update(formData);
      onSuccess('Professional links updated successfully');
      setIsEditing(false);
    } catch (err: any) {
      onError(err);
    }
  };

  const handleCancel = () => {
    setFormData({
      linkedinUrl: profile?.linkedinUrl || '',
      githubUrl: profile?.githubUrl || '',
      portfolioUrl: profile?.portfolioUrl || '',
      websiteUrl: profile?.websiteUrl || '',
    });
    setErrors({});
    setIsEditing(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Professional Links</CardTitle>
        <CardDescription>
          Your online professional profiles
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="linkedinUrl">LinkedIn URL</Label>
            <Input
              id="linkedinUrl"
              type="url"
              value={formData.linkedinUrl}
              onChange={(e) => setFormData({ ...formData, linkedinUrl: e.target.value })}
              disabled={!isEditing}
              placeholder="https://linkedin.com/in/yourprofile"
              className={errors.linkedinUrl ? 'border-destructive' : ''}
            />
            {errors.linkedinUrl && <p className="text-sm text-destructive">{errors.linkedinUrl}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="githubUrl">GitHub URL</Label>
            <Input
              id="githubUrl"
              type="url"
              value={formData.githubUrl}
              onChange={(e) => setFormData({ ...formData, githubUrl: e.target.value })}
              disabled={!isEditing}
              placeholder="https://github.com/yourusername"
              className={errors.githubUrl ? 'border-destructive' : ''}
            />
            {errors.githubUrl && <p className="text-sm text-destructive">{errors.githubUrl}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="portfolioUrl">Portfolio URL</Label>
            <Input
              id="portfolioUrl"
              type="url"
              value={formData.portfolioUrl}
              onChange={(e) => setFormData({ ...formData, portfolioUrl: e.target.value })}
              disabled={!isEditing}
              placeholder="https://yourportfolio.com"
              className={errors.portfolioUrl ? 'border-destructive' : ''}
            />
            {errors.portfolioUrl && <p className="text-sm text-destructive">{errors.portfolioUrl}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="websiteUrl">Website URL</Label>
            <Input
              id="websiteUrl"
              type="url"
              value={formData.websiteUrl}
              onChange={(e) => setFormData({ ...formData, websiteUrl: e.target.value })}
              disabled={!isEditing}
              placeholder="https://yourwebsite.com"
              className={errors.websiteUrl ? 'border-destructive' : ''}
            />
            {errors.websiteUrl && <p className="text-sm text-destructive">{errors.websiteUrl}</p>}
          </div>

          <div className="flex justify-end gap-2">
            {isEditing ? (
              <>
                <Button variant="outline" onClick={handleCancel} type="button">Cancel</Button>
                <Button type="submit">Save</Button>
              </>
            ) : (
              <Button type="button" onClick={() => setIsEditing(true)}>Edit</Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
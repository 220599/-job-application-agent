'use client';

import { useState } from 'react';
import { candidateApi } from '@/lib/api';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import { Input, Label, Button } from '@/components/ui';

const authSchema = z.object({
  workAuthorization: z.string(),
  sponsorshipRequired: z.boolean(),
  willingToRelocate: z.boolean(),
});

type AuthFormData = z.infer<typeof authSchema>;

interface WorkAuthorizationFormProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

const WORK_AUTHORIZATION_OPTIONS = [
  'US_CITIZEN',
  'GREEN_CARD',
  'H1B',
  'OPT',
  'CPT',
  'TN_VISA',
  'E3_VISA',
  'L1_VISA',
  'OTHER',
];

export function WorkAuthorizationForm({ profile, onSuccess, onError }: WorkAuthorizationFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<AuthFormData>({
    workAuthorization: profile?.workAuthorization || 'OTHER',
    sponsorshipRequired: profile?.sponsorshipRequired ?? false,
    willingToRelocate: profile?.willingToRelocate ?? false,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await candidateApi.update(formData);
      onSuccess('Work authorization updated successfully');
      setIsEditing(false);
    } catch (err: any) {
      onError(err);
    }
  };

  const handleCancel = () => {
    setFormData({
      workAuthorization: profile?.workAuthorization || 'OTHER',
      sponsorshipRequired: profile?.sponsorshipRequired ?? false,
      willingToRelocate: profile?.willingToRelocate ?? false,
    });
    setIsEditing(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work Authorization</CardTitle>
        <CardDescription>
          Your work authorization status and preferences
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="workAuthorization">Work Authorization</Label>
            <select
              id="workAuthorization"
              value={formData.workAuthorization}
              onChange={(e) => setFormData({ ...formData, workAuthorization: e.target.value })}
              disabled={!isEditing}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {WORK_AUTHORIZATION_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="sponsorshipRequired"
              type="checkbox"
              checked={formData.sponsorshipRequired}
              onChange={(e) => setFormData({ ...formData, sponsorshipRequired: e.target.checked })}
              disabled={!isEditing}
              className="h-4 w-4 rounded border-input"
            />
            <Label htmlFor="sponsorshipRequired">Sponsorship Required</Label>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="willingToRelocate"
              type="checkbox"
              checked={formData.willingToRelocate}
              onChange={(e) => setFormData({ ...formData, willingToRelocate: e.target.checked })}
              disabled={!isEditing}
              className="h-4 w-4 rounded border-input"
            />
            <Label htmlFor="willingToRelocate">Willing to Relocate</Label>
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
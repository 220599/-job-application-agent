'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { candidateApi } from '@/lib/api';
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
} from '@/components/ui';

const basicInfoSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  preferredName: z.string().optional(),
});

type BasicInfoFormData = z.infer<typeof basicInfoSchema>;

interface BasicInformationFormProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

export function BasicInformationForm({ profile, onSuccess, onError }: BasicInformationFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<BasicInfoFormData>({
    firstName: profile?.firstName || '',
    lastName: profile?.lastName || '',
    preferredName: profile?.preferredName || '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: (data: BasicInfoFormData) =>
      candidateApi.update({
        ...data,
        email: profile?.email,
      }),
    onSuccess: () => {
      onSuccess('Basic information updated successfully');
      setIsEditing(false);
    },
    onError: (err: any) => {
      onError(err);
    },
  });

  const validate = (data: BasicInfoFormData): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!data.firstName.trim()) errors.firstName = 'First name is required';
    if (!data.lastName.trim()) errors.lastName = 'Last name is required';
    return errors;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors = validate(formData);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    mutation.mutate(formData);
  };

  const handleCancel = () => {
    setFormData({
      firstName: profile?.firstName || '',
      lastName: profile?.lastName || '',
      preferredName: profile?.preferredName || '',
    });
    setErrors({});
    setIsEditing(false);
  };

  if (!profile) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Basic Information</CardTitle>
          <CardDescription>
            Your name and preferred display name
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Profile not loaded</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Basic Information</CardTitle>
        <CardDescription>
          Your name and preferred display name
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="firstName">
              First Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="firstName"
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              disabled={mutation.isPending}
              className={errors.firstName ? 'border-destructive' : ''}
            />
            {errors.firstName && (
              <p className="text-sm text-destructive">{errors.firstName}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="lastName">
              Last Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="lastName"
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              disabled={mutation.isPending}
              className={errors.lastName ? 'border-destructive' : ''}
            />
            {errors.lastName && (
              <p className="text-sm text-destructive">{errors.lastName}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="preferredName">Preferred Name (optional)</Label>
            <Input
              id="preferredName"
              value={formData.preferredName}
              onChange={(e) => setFormData({ ...formData, preferredName: e.target.value })}
              disabled={mutation.isPending}
              placeholder="How you prefer to be addressed"
            />
          </div>

          <div className="flex justify-end gap-2">
            {isEditing ? (
              <>
                <Button variant="outline" onClick={handleCancel} disabled={mutation.isPending}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Saving...' : 'Save'}
                </Button>
              </>
            ) : (
              <Button type="button" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
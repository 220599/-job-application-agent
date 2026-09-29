'use client';

import { useState } from 'react';
import { candidateApi } from '@/lib/api';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import { Input, Label, Button } from '@/components/ui';

const contactInfoSchema = z.object({
  email: z.string().email('Invalid email'),
  phone: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  zipCode: z.string().optional(),
});

type ContactInfoFormData = z.infer<typeof contactInfoSchema>;

interface ContactInformationFormProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

export function ContactInformationForm({ profile, onSuccess, onError }: ContactInformationFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<ContactInfoFormData>({
    email: profile?.email || '',
    phone: profile?.phone || '',
    city: profile?.city || '',
    state: profile?.state || '',
    country: profile?.country || '',
    zipCode: profile?.zipCode || '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (data: ContactInfoFormData): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!data.email.trim()) errors.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(data.email)) errors.email = 'Invalid email format';
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
      onSuccess('Contact information updated successfully');
      setIsEditing(false);
    } catch (err: any) {
      onError(err);
    }
  };

  const handleCancel = () => {
    setFormData({
      email: profile?.email || '',
      phone: profile?.phone || '',
      city: profile?.city || '',
      state: profile?.state || '',
      country: profile?.country || '',
      zipCode: profile?.zipCode || '',
    });
    setErrors({});
    setIsEditing(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact Information</CardTitle>
        <CardDescription>
          Your contact details
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email <span className="text-destructive">*</span></Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              disabled={!isEditing}
              className={errors.email ? 'border-destructive' : ''}
            />
            {errors.email && <p className="text-sm text-destructive">{errors.email}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              disabled={!isEditing}
              placeholder="+1 (555) 123-4567"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-2">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                disabled={!isEditing}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="state">State</Label>
              <Input
                id="state"
                value={formData.state}
                onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                disabled={!isEditing}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-2">
              <Label htmlFor="country">Country</Label>
              <Input
                id="country"
                value={formData.country}
                onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                disabled={!isEditing}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="zipCode">ZIP Code</Label>
              <Input
                id="zipCode"
                value={formData.zipCode}
                onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                disabled={!isEditing}
              />
            </div>
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
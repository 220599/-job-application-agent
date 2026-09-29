'use client';

import { useState } from 'react';
import { candidateApi } from '@/lib/api';
import type { WorkMode } from '@jaa/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import { Input, Label, Button } from '@/components/ui';
import { Badge } from '@/components/ui';

interface WorkPreferencesFormProps {
  profile: any;
  onSuccess: (msg: string) => void;
  onError: (err: any) => void;
}

const WORK_MODE_OPTIONS: WorkMode[] = ['REMOTE', 'HYBRID', 'ONSITE', 'ANY'];

export function WorkPreferencesForm({ profile, onSuccess, onError }: WorkPreferencesFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [preferredWorkMode, setPreferredWorkMode] = useState<WorkMode>(profile?.preferredWorkMode || 'ANY');
  const [preferredLocations, setPreferredLocations] = useState<string[]>(profile?.preferredLocations || []);
  const [desiredRoles, setDesiredRoles] = useState<string[]>(profile?.desiredRoles || []);
  const [desiredSalaryMin, setDesiredSalaryMin] = useState<number | ''>((profile?.desiredSalaryMin ?? '') as any);
  const [desiredSalaryMax, setDesiredSalaryMax] = useState<number | ''>((profile?.desiredSalaryMax ?? '') as any);
  const [locationInput, setLocationInput] = useState('');
  const [roleInput, setRoleInput] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const min = desiredSalaryMin === '' ? undefined : Number(desiredSalaryMin);
    const max = desiredSalaryMax === '' ? undefined : Number(desiredSalaryMax);

    if (min !== undefined && max !== undefined && min > max) {
      onError({ message: 'Minimum salary cannot be greater than maximum salary' });
      return;
    }

    try {
      await candidateApi.update({
        preferredWorkMode,
        preferredLocations,
        desiredRoles,
        desiredSalaryMin: min,
        desiredSalaryMax: max,
      });
      onSuccess('Work preferences updated successfully');
      setIsEditing(false);
    } catch (err: any) {
      onError(err);
    }
  };

  const handleCancel = () => {
    setPreferredWorkMode(profile?.preferredWorkMode || 'ANY');
    setPreferredLocations(profile?.preferredLocations || []);
    setDesiredRoles(profile?.desiredRoles || []);
    setDesiredSalaryMin((profile?.desiredSalaryMin ?? '') as any);
    setDesiredSalaryMax((profile?.desiredSalaryMax ?? '') as any);
    setLocationInput('');
    setRoleInput('');
    setIsEditing(false);
  };

  const addTag = (setter: (val: string[]) => void, input: string, setInput: (val: string) => void, currentValues: string[]) => {
    const trimmed = input.trim();
    if (trimmed && !currentValues.includes(trimmed)) {
      setter([...currentValues, trimmed]);
    }
    setInput('');
  };

  const removeTag = (setter: (val: string[]) => void, values: string[], value: string) => {
    setter(values.filter((v) => v !== value));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work Preferences</CardTitle>
        <CardDescription>
          Your preferred work arrangements and role types
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label>Preferred Work Mode</Label>
            <div className="flex flex-wrap gap-2">
              {WORK_MODE_OPTIONS.map((mode) => (
                <label key={mode} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="workMode"
                    value={mode}
                    checked={preferredWorkMode === mode}
                    onChange={(e) => setPreferredWorkMode(e.target.value as WorkMode)}
                    disabled={!isEditing}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{mode.charAt(0) + mode.slice(1).toLowerCase()}</span>
                </label>
              ))}
            </div>
          </div>

          {isEditing && (
            <>
              <div className="grid gap-2">
                <Label>Preferred Locations</Label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {preferredLocations.map((loc) => (
                    <Badge key={loc} variant="secondary">
                      {loc}
                      <button
                        type="button"
                        onClick={() => removeTag(setPreferredLocations, preferredLocations, loc)}
                        className="ml-1 rounded-full p-0.5 hover:bg-muted"
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={locationInput}
                    onChange={(e) => setLocationInput(e.target.value)}
                    placeholder="Add a location (e.g., San Francisco)"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTag(setPreferredLocations, locationInput, setLocationInput, preferredLocations);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addTag(setPreferredLocations, locationInput, setLocationInput, preferredLocations)}
                  >
                    Add
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Desired Roles</Label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {desiredRoles.map((role) => (
                    <Badge key={role} variant="secondary">
                      {role}
                      <button
                        type="button"
                        onClick={() => removeTag(setDesiredRoles, desiredRoles, role)}
                        className="ml-1 rounded-full p-0.5 hover:bg-muted"
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={roleInput}
                    onChange={(e) => setRoleInput(e.target.value)}
                    placeholder="Add a desired role"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTag(setDesiredRoles, roleInput, setRoleInput, desiredRoles);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addTag(setDesiredRoles, roleInput, setRoleInput, desiredRoles)}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </>
          )}

          {!isEditing && preferredLocations.length > 0 && (
            <div className="grid gap-2">
              <Label>Preferred Locations</Label>
              <div className="flex flex-wrap gap-2">
                {preferredLocations.map((loc) => (
                  <Badge key={loc} variant="secondary">{loc}</Badge>
                ))}
              </div>
            </div>
          )}

          {!isEditing && desiredRoles.length > 0 && (
            <div className="grid gap-2">
              <Label>Desired Roles</Label>
              <div className="flex flex-wrap gap-2">
                {desiredRoles.map((role) => (
                  <Badge key={role} variant="secondary">{role}</Badge>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label>Desired Salary Range</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                value={desiredSalaryMin === '' ? '' : desiredSalaryMin}
                onChange={(e) => setDesiredSalaryMin(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="Min"
                disabled={!isEditing}
              />
              <Input
                type="number"
                value={desiredSalaryMax === '' ? '' : desiredSalaryMax}
                onChange={(e) => setDesiredSalaryMax(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="Max"
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
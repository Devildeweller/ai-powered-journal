import { Angry, Frown, Laugh, Meh, Smile } from 'lucide-react';

/** Mood is a 1–5 scale; each step has a word and a face so it is never colour alone. */
export const MOODS = [
  { value: 1, label: 'Rough', Icon: Angry },
  { value: 2, label: 'Low', Icon: Frown },
  { value: 3, label: 'Okay', Icon: Meh },
  { value: 4, label: 'Good', Icon: Smile },
  { value: 5, label: 'Great', Icon: Laugh },
];

export const moodFor = (value) => MOODS.find((mood) => mood.value === value) ?? null;

export const MEMORY_CATEGORIES = [
  { value: 'identity', label: 'About me' },
  { value: 'relationship', label: 'People' },
  { value: 'goal', label: 'Goals' },
  { value: 'preference', label: 'Preferences' },
  { value: 'health', label: 'Health' },
  { value: 'work', label: 'Work' },
  { value: 'event', label: 'Events' },
  { value: 'pattern', label: 'Patterns' },
  { value: 'other', label: 'Other' },
];

export const categoryLabel = (value) => MEMORY_CATEGORIES.find((category) => category.value === value)?.label ?? 'Other';

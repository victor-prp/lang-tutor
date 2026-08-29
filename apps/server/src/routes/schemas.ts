import { z } from 'zod';

export const CreateSessionRequestSchema = z.object({
  user_id: z.string().min(1),
});

export const NextStepRequestSchema = z.object({
  user_id: z.string().min(1),
  question_id: z.string().min(1),
  option_index: z.number().int().nonnegative(),
});

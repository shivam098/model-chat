import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(254),
  password: z.string().min(12, "Use a password with at least 12 characters.").max(128),
  name: z.string().trim().min(1).max(80).optional(),
}).strict().transform(input => ({
  ...input,
  name: input.name ?? input.email.split("@")[0].slice(0, 80),
}));

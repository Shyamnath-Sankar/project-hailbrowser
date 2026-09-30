import type { PageType } from "../shared/types";

const RE = {
  quiz: /\b(quiz|exam|assessment|test|question\s*\d|submit\s+(answers|quiz)|graded)\b/i,
  instructions: /\b(instructions|before you (begin|start)|read (this|carefully)|rules|grading|honor code|attempts allowed|passing (grade|score)|time limit)\b/i,
  login: /\b(sign in|log in|login|password|continue with (google|apple|github))\b/i,
  captcha: /\b(captcha|verify you are human|i'?m not a robot|security check)\b/i,
};

/**
 * Cheap, rule-based page labelling. The label picks which skill loads, so it
 * only has to be directionally right; the executor can correct it.
 */
export function classifyPage(text: string, hasMedia: boolean): PageType {
  const sample = text.slice(0, 4000);

  if (RE.captcha.test(sample)) return "captcha";
  if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="challenge" i]')) {
    return "captcha";
  }

  const passwordField = document.querySelector('input[type="password"]');
  if (passwordField && RE.login.test(sample)) return "login";

  // Instructions win over quiz: a page that explains the rules must be captured
  // before the agent is allowed to start answering anything.
  const radios = document.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
  if (RE.instructions.test(sample) && radios < 2) return "instructions";
  if (RE.quiz.test(sample) && radios >= 2) return "quiz";

  if (hasMedia) return "video";

  const forms = document.querySelectorAll("form").length;
  const inputs = document.querySelectorAll("input:not([type=hidden]), textarea, select").length;
  if (forms > 0 && inputs >= 3) return "form";

  const links = document.querySelectorAll("a[href]").length;
  if (text.length < 400 && links > 25) return "listing";

  if (text.length > 800) return "reading";
  return "unknown";
}

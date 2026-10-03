import type { QuestionAnswers, RemoteQuestion } from './client';

export function questionValidation(questions: RemoteQuestion[], answers: QuestionAnswers): string | null {
  for (const question of questions) {
    const values = (answers[question.id] ?? []).filter((value) => question.allowEmpty || value.trim().length > 0);
    if (question.required && !values.length) return `请回答：${question.header || question.question}`;
    if (!question.multiSelect && values.length > 1) return '这道题只能选择一个答案';
    if (values.some((value) => value.length > 4000)) return '回答过长';
    if (question.options?.length && !question.allowCustom && values.some((value) => !question.options!.some((option) => option.label === value))) return '请选择题目中的选项';
    if (question.inputType === 'boolean' && values.some((value) => value !== 'true' && value !== 'false')) return '请选择是或否';
    if (question.inputType === 'number' || question.inputType === 'integer') {
      for (const value of values) {
        const number = Number(value);
        if (!Number.isFinite(number) || (question.inputType === 'integer' && !Number.isSafeInteger(number)) || (question.min !== undefined && number < question.min) || (question.max !== undefined && number > question.max)) return '请填写范围内的数字';
      }
    }
  }
  return null;
}

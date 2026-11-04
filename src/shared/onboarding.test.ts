import { describe, expect, it } from 'vitest';
import { onboardingQuery, onboardingRequest, startStep } from './onboarding.ts';

describe('onboarding 從哪一步開始', () => {
  it('回到停下來的那一步', () => {
    expect(startStep('intro', false)).toBe('intro');
    expect(startStep('signIn', false)).toBe('signIn');
  });

  it('已經登入：第 2 步直接跳到第 3 步（選擇方案）', () => {
    expect(startStep('signIn', true)).toBe('plan');
    expect(startStep('plan', true)).toBe('plan');
  });

  it('停在選擇方案，但登入已經失效：回到第 2 步', () => {
    expect(startStep('plan', false)).toBe('signIn');
  });

  it('side panel 的「登入」「改用內建翻譯」：從第 2 步開始，即使設定早就完成', () => {
    expect(startStep('done', false, 'signIn')).toBe('signIn');
    expect(startStep('done', true, 'signIn')).toBe('plan');
  });
});

describe('點圖示時卡住，打開 onboarding 的那一步（#185）', () => {
  it('額度 0：直接到選擇方案；登入已經失效就先登入', () => {
    expect(startStep('done', true, 'plan')).toBe('plan');
    expect(startStep('done', false, 'plan')).toBe('signIn');
  });

  it('自備金鑰沒有 key：直接到「使用自備金鑰」', () => {
    expect(startStep('done', false, 'ownKey')).toBe('ownKey');
  });

  it('網址帶著要跳的步驟與漫畫的分頁', () => {
    expect(onboardingRequest('?step=plan&from=12')).toEqual({ step: 'plan', from: 12 });
    expect(onboardingRequest('?step=signIn')).toEqual({ step: 'signIn' });
    expect(onboardingRequest('?step=nope&from=x')).toEqual({});
  });

  it('組出來的網址讀得回去', () => {
    expect(onboardingRequest(onboardingQuery('ownKey', 7))).toEqual({ step: 'ownKey', from: 7 });
  });
});

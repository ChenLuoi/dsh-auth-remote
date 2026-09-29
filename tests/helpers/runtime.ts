import { chromium, type Locator, type Page } from '@playwright/test'
import { archive, packageName, project, selectedTestDsh } from '../../scripts/runtime.mjs'

export { archive, packageName, project }
export const dsh = selectedTestDsh()

export function launchBrowser(args: string[] = []) {
  const executablePath = process.env.DSH_TEST_BROWSER?.trim()
  return chromium.launch({
    headless: true,
    args,
    ...(executablePath ? { executablePath } : {}),
  })
}

export async function completeApiKeyPrompt(page: Page, waitMs = 0): Promise<boolean> {
  const continueButton = page.getByRole('button', { name: '保存并继续' })
  if (waitMs) {
    await continueButton.waitFor({ state: 'visible', timeout: waitMs }).catch(() => {})
  }
  if (!(await continueButton.isVisible())) return false
  await page.getByRole('textbox', { name: 'API 密钥' }).fill('browser-test-key')
  await continueButton.click()
  await page.getByText('添加一个 API Key 开始使用').waitFor({ state: 'hidden' })
  return true
}

export async function clickThroughDshPrompts(
  page: Page,
  target: Locator,
  reopen?: Locator,
): Promise<void> {
  const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
  // Onboarding can mount after the frame or briefly reload it after saving.
  // Recheck the known prompts between short clicks instead of spending the
  // entire action timeout blocked behind a late modal.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await notice.isVisible()) {
      await notice.getByRole('button', { name: '继续' }).click()
      await notice.waitFor({ state: 'hidden' })
      await completeApiKeyPrompt(page, 5000)
    }
    await completeApiKeyPrompt(page)
    try {
      // Saving the first API key can reload older hosts and close Settings.
      if (reopen && !(await target.isVisible())) await reopen.click({ timeout: 2000 })
      await target.click({ timeout: 2000 })
      return
    } catch (error) {
      if (attempt === 5)
        throw new Error(
          `DSH prompt interaction failed: ${(await page.locator('body').innerText()).slice(0, 2000)}`,
          { cause: error },
        )
    }
  }
}

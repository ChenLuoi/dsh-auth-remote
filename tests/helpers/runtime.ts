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

export async function completeApiKeyPrompt(page: Page): Promise<boolean> {
  const continueButton = page.getByRole('button', { name: '保存并继续' })
  if (!(await continueButton.isVisible())) return false
  await page.getByRole('textbox', { name: 'API 密钥' }).fill('browser-test-key')
  await continueButton.click()
  await page.getByText('添加一个 API Key 开始使用').waitFor({ state: 'hidden' })
  return true
}

export async function clickThroughDshPrompts(page: Page, target: Locator): Promise<void> {
  const notice = page.getByRole('dialog', { name: '内测声明' })
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await notice.isVisible()) {
      await notice.getByRole('button', { name: '继续' }).click()
      await notice.waitFor({ state: 'hidden' })
    }
    await completeApiKeyPrompt(page)
    try {
      await target.click({ timeout: 3000 })
      return
    } catch (error) {
      if (attempt === 2 || (!(await notice.isVisible()) && !(await completeApiKeyPrompt(page))))
        throw error
    }
  }
}

import { chromium, expect, type Locator, type Page } from '@playwright/test'
import { archive, packageName, project, selectedTestDsh } from '../../scripts/runtime.mjs'

export { archive, packageName, project }
export const dsh = selectedTestDsh()

// Shared pnpm hardlinks change ctime when another profile installs the same
// archive. DSH watches ctime for HMR, so test profiles need independent copies.
process.env.pnpm_config_package_import_method = 'copy'

export function launchBrowser(args: string[] = []) {
  const executablePath = process.env.DSH_TEST_BROWSER?.trim()
  return chromium.launch({
    headless: true,
    args,
    ...(executablePath ? { executablePath } : {}),
  })
}

/** Capture the settled layout after responsive sidebars finish painting. */
export async function waitForAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    )
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished.catch(() => {})),
    )
    await new Promise<void>((done) => requestAnimationFrame(() => done()))
  })
}

export async function completeApiKeyPrompt(page: Page, waitMs = 0): Promise<boolean> {
  const continueButton = page.getByRole('button', { name: '保存并继续' })
  const apiKeyChoice = page
    .getByRole('dialog', { name: '登录 DeepSeek 账号', exact: true })
    .getByRole('button', { name: '使用 API Key', exact: true })
  if (waitMs) {
    await continueButton
      .or(apiKeyChoice)
      .waitFor({ state: 'visible', timeout: waitMs })
      .catch(() => {})
  }
  if (await apiKeyChoice.isVisible()) {
    await apiKeyChoice.click()
    await continueButton.waitFor({ state: 'visible' })
  }
  if (!(await continueButton.isVisible())) return false
  await page.getByRole('textbox', { name: 'API 密钥' }).fill('browser-test-key')
  await continueButton.click()
  await page.getByText('添加一个 API Key 开始使用').waitFor({ state: 'hidden' })
  return true
}

/** Theme clicks paint optimistically; wait for the durable host write before leaving General. */
export async function selectDshTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const option = page.getByRole('button', {
    name: theme === 'light' ? '浅色' : '深色',
    exact: true,
  })
  if ((await option.getAttribute('aria-pressed')) !== 'true') {
    const mutation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/settings/mutate' &&
        response.request().postData()?.includes('ui-theme') === true,
    )
    await option.click()
    const response = await mutation
    expect(response.status()).toBe(200)
    expect((await response.json()).result.ok).toBe(true)
  }
  await expect(option).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => page.locator('body').evaluate((node) => node.hasAttribute('data-ds-dark-theme')))
    .toBe(theme === 'dark')
}

export async function clickThroughDshPrompts(
  page: Page,
  target: Locator,
  reopen?: () => Promise<void>,
): Promise<void> {
  const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明|Preview Notice)$/u })
  // Onboarding can mount after the frame or briefly reload it after saving.
  // Recheck the known prompts between short clicks instead of spending the
  // entire action timeout blocked behind a late modal.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await notice.isVisible()) {
      // Acknowledgement can replace the notice while its write is pending.
      // Limit each click, then re-evaluate the current modal in this loop.
      try {
        await notice.getByRole('button', { name: /^(?:继续|Continue)$/u }).click({ timeout: 2000 })
        await notice.waitFor({ state: 'hidden', timeout: 5000 })
      } catch (error) {
        if (attempt === 5) throw error
        continue
      }
      await completeApiKeyPrompt(page, 5000)
    }
    await completeApiKeyPrompt(page)
    const signIn = page.getByRole('dialog', {
      name: /^(?:开始使用|Get started|登录 DeepSeek 账号|Sign in to DeepSeek)$/u,
    })
    if (await signIn.isVisible()) {
      // A native onboarding portal can remain behind an already opened Settings
      // panel. Prefer the actual target when it accepts interaction on top.
      if (await target.isVisible()) {
        try {
          await target.click({ timeout: 1000 })
          return
        } catch {
          /* The prompt is in front; dismiss it below. */
        }
      }
      try {
        await signIn.getByRole('button', { name: /^(?:关闭|Close)$/u }).click({ timeout: 2000 })
      } catch (error) {
        if (attempt === 5) throw error
        continue
      }
    }
    try {
      // Saving the first API key can reload older hosts and close Settings.
      if (reopen && !(await target.isVisible())) await reopen()
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

/** Older sidebars expose Settings directly; alpha.3 moves it into the account menu. */
export async function openDshSettings(page: Page, locale: 'zh' | 'en' = 'zh'): Promise<void> {
  const name = locale === 'zh' ? '设置' : 'Settings'
  const dialog = page.getByRole('dialog', { name, exact: true })
  const accountMenu = page.getByRole('button', {
    name: locale === 'zh' ? '账号菜单' : 'Account menu',
    exact: true,
  })
  const direct = page.getByRole('button', { name, exact: true })
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await dialog.isVisible()) return
    await clickThroughDshPrompts(page, direct.or(accountMenu))
    if (await accountMenu.isVisible()) {
      const item = page.getByRole('menuitem', { name, exact: true })
      await clickThroughDshPrompts(page, item, async () => {
        if (!(await item.isVisible())) await accountMenu.click()
      })
    }
    try {
      // Older hosts can finish onboarding and reload after the click succeeds.
      // Confirm the destination, then handle any late native prompt and reopen.
      await dialog.waitFor({ timeout: 2000 })
      return
    } catch (error) {
      if (attempt === 5)
        throw new Error(
          `DSH Settings did not open: ${(await page.locator('body').innerText()).slice(0, 2000)}`,
          { cause: error },
        )
    }
  }
}

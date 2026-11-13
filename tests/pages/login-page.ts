import { type Locator, type Page, expect } from '@playwright/test';

/** Page Object for the Book Store login (https://demoqa.com/login). */
export class LoginPage {
  readonly userName: Locator;
  readonly password: Locator;
  readonly loginButton: Locator;

  constructor(private readonly page: Page) {
    // User-facing locators: placeholders for the fields, role and name for the button.
    this.userName = page.getByPlaceholder('UserName');
    this.password = page.getByPlaceholder('Password');
    this.loginButton = page.getByRole('button', { name: 'Login' });
  }

  // Go to the login page and wait until it's usable (the button is visible).
  async open(): Promise<void> {
    await this.page.goto('/login');
    await expect(this.loginButton).toBeVisible();
  }

  // Fill both fields and submit.
  async login(user: string, password: string): Promise<void> {
    await this.userName.fill(user);
    await this.password.fill(password);
    await this.loginButton.click();
  }
}

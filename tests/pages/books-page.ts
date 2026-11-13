import { type Locator, type Page, expect } from '@playwright/test';

/** Page Object for the Book Store (https://demoqa.com/books). Same as the Playwright class. */
export class BooksPage {
  // Locators are defined once here, so the tests read like steps, not selectors.
  readonly searchBox: Locator;
  readonly bookLinks: Locator;

  constructor(private readonly page: Page) {
    // Found the way a user would: by placeholder text and by role (the links inside the books table).
    this.searchBox = page.getByPlaceholder('Type to search');
    this.bookLinks = page.getByRole('table').getByRole('link');
  }

  /**
   * Opens the store. Doesn't wait for anything on the page: when the books API fails,
   * DemoQA renders a blank page, and exploring a broken page is the point of Project 2.
   */
  async open(): Promise<void> {
    await this.page.goto('/books');
  }

  // Type into the search box (it filters the table as you type).
  async search(term: string): Promise<void> {
    await expect(this.searchBox).toBeVisible();
    await this.searchBox.fill(term);
  }

  // Click a book by its visible title.
  async openBook(title: string): Promise<void> {
    await this.page.getByRole('link', { name: title }).click();
  }
}

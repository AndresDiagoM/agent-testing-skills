# Template: `with-page-ready.tsx`

Code template shipped as Markdown in the directory edition (full edition: `assets/kit/app/with-page-ready.tsx`).
Copy the code below into the user's repository as `with-page-ready.tsx` and adapt it as the references say.
The plugin never runs it.

```tsx
/**
 * with-page-ready.tsx (Next.js App Router template).
 * Usage in a route (works for async Server Components and keeps the page's props type):
 *
 *   export default withPageReady(async function Page(props: PageProps) { ... });
 *
 * Renders <PageReady /> right after whatever the page returns, on every return path (early returns, empty states).
 * `redirect()` and `notFound()` throw before it, which is right: the page they land on renders its own marker.
 * Wrap every route page, not-found and error boundary that tests navigate to; goto-ready.ts reports a page that
 * lacks it. Adjust the import path to where page-ready.tsx lives.
 */
import { PageReady } from './page-ready';

export function withPageReady<P>(
  Page: (props: P) => React.ReactNode | Promise<React.ReactNode>,
): (props: P) => Promise<React.ReactElement> {
  async function PageWithReady(props: P) {
    const content = await Page(props);
    return (
      <>
        {content}
        <PageReady />
      </>
    );
  }
  return PageWithReady;
}
```

export type BreadcrumbItem = {
  label: string;
  href?: string;
  swap?: string;
};

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" class="text-sm breadcrumbs mb-2" data-testid="breadcrumbs">
      <ul>
        {items.map((item) => (
          <li>
            {item.href && item.swap ? (
              <a
                href={item.href}
                p-href={item.href}
                p-target="content"
                p-swap={item.swap}
                class="lp-focus-ring rounded-md"
              >
                {item.label}
              </a>
            ) : (
              item.label
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

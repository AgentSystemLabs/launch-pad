export type BreadcrumbItem = {
  label: string;
  href?: string;
};

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" class="text-sm breadcrumbs mb-2" data-testid="breadcrumbs">
      <ul>
        {items.map((item) => (
          <li>
            {item.href ? (
              <a href={item.href} class="lp-focus-ring rounded-md">
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

import { cn } from '@/lib/cn';

function Separator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('h-px bg-muted my-6', className)}
      {...props}
    />
  );
}

export { Separator };
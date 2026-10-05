import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-mono uppercase tracking-wider text-sm transition-all duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-signal)] focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        primary: 'bg-[color:var(--color-signal)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-signal-hi)] active:scale-[0.98]',
        ghost: 'btn-underline border border-[color:var(--color-steel)] text-[color:var(--color-paper)] hover:border-[color:var(--color-signal)] hover:text-[color:var(--color-signal)]',
        link: 'text-[color:var(--color-paper)] hover:text-[color:var(--color-signal)] underline-offset-4 hover:underline px-0',
      },
      size: {
        sm: 'h-9 px-4',
        md: 'h-12 px-6',
        lg: 'h-14 px-8 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

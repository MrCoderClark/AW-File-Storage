import { CreateCardForm } from "@/components/create-card-form";

// Create Card — build and publish a contact card from a form (spec 0006).
export default function CreateCardPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-col items-center text-center">
        <CardIcon className="h-14 w-14 text-accent-500" />
        <h1 className="mt-3 text-2xl font-semibold text-brand-900">
          Create a contact card
        </h1>
        <p className="mt-1 text-sm text-muted-500">
          Enter the details and we&apos;ll publish a vCard to a public address —
          no file needed.
        </p>
      </div>

      <div className="mt-6">
        <CreateCardForm />
      </div>
    </div>
  );
}

function CardIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10.5" r="1.8" />
      <path d="M5.5 16a3 3 0 0 1 6 0M14 9h4M14 12h4M14 15h2.5" strokeLinecap="round" />
    </svg>
  );
}

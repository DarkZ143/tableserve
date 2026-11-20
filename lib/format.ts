export function money(paise: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
}

export function humanizeStatus(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "permission-denied") {
    return "Firebase connected, but Firestore denied access. Deploy the current Firestore rules and check this account has an active restaurant or platform role.";
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

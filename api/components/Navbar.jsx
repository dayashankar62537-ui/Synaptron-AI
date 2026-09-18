import { SignInButton, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";

export default function Navbar() {
  return (
    <header className="flex justify-between items-center px-6 py-4 bg-black/80 text-white">
      {/* Logo */}
      <div className="text-xl font-bold">AVIqo AI</div>

      <div className="flex items-center gap-4">
        {/* 1. Jab User Logged OUT ho: Tab sirf ye Sign Up button dikhega */}
        <SignedOut>
          <SignInButton mode="modal">
            <button className="bg-orange-500 hover:bg-orange-600 text-white font-medium px-4 py-2 rounded-lg transition">
              Sign Up Now
            </button>
          </SignInButton>
        </SignedOut>

        {/* 2. Jab User Logged IN ho jaye: Sign Up button gayab ho jayega aur ye Profile Icon dikhega */}
        <SignedIn>
          <UserButton afterSignOutUrl="/" />
        </SignedIn>
      </div>
    </header>
  );
}

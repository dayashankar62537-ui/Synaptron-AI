import { SignInButton, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";

export default function Navbar() {
  return (
    <div className="flex justify-between items-center p-4">
      {/* Signed Out State: Direct Google Modal open hoga */}
      <SignedOut>
        <SignInButton mode="modal">
          <button className="bg-orange-500 hover:bg-orange-600 text-white font-medium px-5 py-2 rounded-lg">
            Sign Up Now
          </button>
        </SignInButton>
      </SignedOut>

      {/* Signed In State: User Google Avatar dikhega */}
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
    </div>
  );
}

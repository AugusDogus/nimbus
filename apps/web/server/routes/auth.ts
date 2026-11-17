import { auth } from "@/lib/auth";
import { handleAuthRequest } from "@/lib/nimbus-auth";

const handler = (request: Request) => handleAuthRequest(auth, request);

export { handler as GET, handler as POST };

export async function DELETE() {
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie":
        "corner_customer_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}

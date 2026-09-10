const value =
  process.env.PALLADIAN_TEST_FRONTEND_ORIGIN ?? "http://localhost:5173";
const url = new URL(value);
if (
  url.origin !== value ||
  url.protocol !== "http:" ||
  url.hostname !== "localhost" ||
  !url.port
) {
  throw new Error(
    "Expected an exact localhost HTTP origin with an explicit port",
  );
}
export const frontendOrigin = value;

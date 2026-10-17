import DeliveryBoyGame from "./delivery-boy-game";

export const metadata = {
  title: "Delivery Boy | Corner Deli Operations",
  description: "Corner Deli delivery arcade mini-game with leaderboards.",
};

export default function DeliveryBoyPage() {
  return (
    <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center p-4">
      <DeliveryBoyGame />
    </main>
  );
}

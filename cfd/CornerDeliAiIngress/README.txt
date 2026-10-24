Corner Deli AI Ingress CFD

1. Open CornerDeliAiIngress.cfdproj in 3CX Call Flow Designer.
2. Replace PASTE_EXISTING_CORNEROPS_CRM_SECRET_HERE with the same API secret used by the existing Corner Deli caller-popup CFD. Keep the surrounding quotes.
3. Build the project and upload the generated ZIP to 3CX.
4. Route the AI test DID to this Call Flow App instead of directly to extension 100.

The flow captures session.ani before 3CX replaces the external caller ID, notifies Corner Ops, and then transfers seamlessly to AI extension 100.

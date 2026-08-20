export type HandbookSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export const CORNER_DELI_HANDBOOK_VERSION = "2026-08-20";
export const CORNER_DELI_HANDBOOK_EFFECTIVE_DATE = "August 20, 2026";

export const CORNER_DELI_HANDBOOK_TITLE = "Corner Deli Employee Handbook";

export const CORNER_DELI_HANDBOOK_INTRO = [
  "This handbook explains the day-to-day standards expected of Corner Deli employees. The goal is simple: serve customers well, work safely, communicate with the team, protect food quality, handle money honestly, and keep the operation moving efficiently.",
  "No handbook can cover every situation. Management may make reasonable operational decisions as circumstances require, and policies may be updated when business needs or applicable law change. Employees will be asked to acknowledge material handbook revisions.",
];

export const CORNER_DELI_HANDBOOK_SECTIONS: HandbookSection[] = [
  {
    title: "1. Customer service: the customer is always right (even when they are not)",
    bullets: [
      "Do not argue with a customer. Stay calm, clarify the problem, and make a reasonable effort to resolve it before transferring the customer to a manager.",
      "If a customer becomes threatening, discriminatory, harassing, or unsafe, employees are not required to absorb the abuse. Step away and involve the manager on duty immediately.",
      "Be polite when asking a customer to repeat information you did not hear. A correct order is faster than remaking a wrong one.",
      "Answer phones promptly and professionally. Use caller ID when available and verify delivery addresses and callback numbers before completing a delivery order.",
    ],
  },
  {
    title: "2. Attendance, scheduling, pace, and communication",
    bullets: [
      "Report to work on time and ready to begin working at the scheduled start time.",
      "Employees are expected to work at a safe, efficient pace, move with purpose, multitask when appropriate, answer phones, and help coworkers rather than waiting for a task to be assigned when work is obviously available.",
      "Schedule conflicts, call-offs, lateness, transportation problems, and other foreseeable issues must be communicated to management as early as possible. Problems that are not communicated in advance place the burden on the rest of the team and may result in discipline.",
      "No-call/no-show absences, repeated lateness, or repeated failure to follow the call-off procedure may result in discipline up to and including termination.",
      "During training, employees may be scheduled across different days and time periods so they can learn the operation. After training, management will generally try to maintain consistent schedules when business needs allow.",
      "Do not work off the clock, clock in or out for another employee, or ask another employee to do so. Report missed or incorrect punches promptly.",
    ],
  },
  {
    title: "3. Employee meal benefit",
    paragraphs: [
      "The employee meal is a company benefit and is separate from any meal period required by law.",
    ],
    bullets: [
      "One meal from the approved employee menu is provided for each working day when the employee works a shift of at least 6 hours.",
      "Employee meals are portioned the same way as a customer's meal. Employee status is not a license to invent a heroic sandwich.",
      "A food mistake may be taken as the employee's meal only when the item is on the employee menu and a manager approves it. If the employee has already taken a meal for the day, the manager on duty decides what happens to the mistake.",
      "All employee meals are prepared by the cooks. Delivery drivers may not prepare their own employee meals.",
      "Employees must ask permission before an employee meal is made or taken.",
      "The free meal may be obtained before the shift, during a clocked-out meal period, or after the shift. It may not be eaten while the employee is supposed to be working.",
      "Drinks are not included in the employee meal benefit unless management specifically authorizes otherwise.",
    ],
  },
  {
    title: "4. Breaks and meal periods",
    bullets: [
      "Meal periods and other breaks are scheduled around business conditions and applicable law. Exact timing may change during a rush.",
      "Before leaving the work area for a break, give the manager and nearby coworkers a heads-up so coverage is maintained.",
      "An unpaid meal period is unpaid only when the employee is fully relieved of work duties. Employees on an unpaid meal period are free to leave the premises unless a different lawful arrangement is specifically communicated.",
      "If an employee is interrupted or performs work during an unpaid meal period, report it so the working time can be recorded and paid.",
      "Short rest breaks, when provided, are treated as paid time when required by applicable law.",
    ],
  },
  {
    title: "5. Order taking and phone standards",
    bullets: [
      "Employees who take orders must learn the menu, including the normal sides and condiments that come with menu items.",
      "Do not read every optional modifier to the customer. Optional modifiers exist for customers who request a special order. Follow the normal ordering script and move to the next necessary question.",
      "For example, do not turn a simple chicken quesadilla order into a recital of salsa, jalapenos, buffalo sauce, and every other possible button on the screen unless the customer asks to customize it.",
      "For subs and similar items, follow the established script instead of listing every condiment and topping in the system.",
      "Use caller ID information as a tool, but still confirm information that matters to the order. Delivery addresses must be verified before the order is sent to the kitchen or driver.",
      "Read back or confirm details when an order is unusual, unclear, expensive, or likely to create a costly mistake.",
    ],
  },
  {
    title: "6. Delivery drivers",
    bullets: [
      "The rear delivery cash drawer is set to $0 at the end of each night. Each delivery money bag is normally set to $60 at the beginning of the shift.",
      "Count the delivery bag before beginning the shift and report any discrepancy immediately. Do not silently inherit someone else's mismatch.",
      "The target $60 bag mix is $10 in tens (1 x $10), $25 in fives (5 x $5), $23 in ones (23 x $1), and $2 in quarters (8 x $0.25), subject to available change.",
      "Each delivery order must be properly cashed out and the drawer/bag totals must reconcile at the end of the shift. Cash shortages or overages must be reported to management. The company will not make unauthorized deductions from wages or tips for shortages; repeated or unexplained mismatches may still result in investigation and discipline.",
      "Drivers are part of a team. During busy periods, management may group deliveries by location and rotate grouped runs among drivers.",
      "Drivers may not dis-group deliveries, skip the rotation, take another driver's turn, or manipulate routes in order to maximize personal tips or cherry-pick orders.",
      "When management groups deliveries, credit-card tips may be divided among the assigned drivers under the company's tip procedures and applicable law.",
      "For delivery orders requiring items from the front of the store, obtain those items first, bring them to the rear for final bagging, and only then move the completed order to the delivery vehicle.",
      "Drivers must maintain any license, registration, and insurance required for their driving duties, obey traffic laws, wear seat belts, and never use a handheld phone while driving. Accidents, tickets affecting driving privileges, or vehicle safety problems must be reported promptly.",
    ],
  },
  {
    title: "7. Cooks and kitchen production",
    bullets: [
      "Read the entire order slip. Follow the manager's direction about how orders should be grouped and timed.",
      "Use fryer capacity efficiently. Multiple orders of the same product may be cooked in the same basket when doing so improves speed without sacrificing food quality, portion accuracy, allergen controls, or correct order assembly.",
      "Portioning standards exist for a reason. Follow the established portions, recipes, and build standards consistently for customers and employees.",
      "Keep the line moving while maintaining safe food handling. Speed does not excuse serving an unsafe or obviously incorrect product.",
      "Unauthorized personal cell-phone use while actively working, especially in food-preparation and service areas, is prohibited and may result in discipline up to and including termination.",
      "Non-emergency personal calls should be handled during an approved break and away from the active work area.",
    ],
  },
  {
    title: "8. Food safety, sanitation, and illness reporting",
    bullets: [
      "Follow all required handwashing, glove, utensil, temperature, storage, labeling, date-marking, and cross-contamination procedures.",
      "Clean as you go. Keep prep surfaces, equipment, floors, coolers, freezers, sinks, bathrooms, dining areas, and workstations in sanitary condition throughout the shift, not merely at closing.",
      "Report spills, broken equipment, unsafe temperatures, pest activity, contamination concerns, and other food-safety problems immediately.",
      "Employees must report symptoms or conditions that food-safety rules require to be reported. Management will handle work restrictions or exclusions as required by law and public-health rules.",
      "Never serve food you reasonably believe is contaminated, spoiled, improperly held, or otherwise unsafe. Stop and ask a manager.",
    ],
  },
  {
    title: "9. Cash, discounts, comps, voids, tips, and honesty",
    bullets: [
      "Handle company money and customer payments accurately. Do not borrow from drawers, bags, deposits, or company funds.",
      "Do not create unauthorized discounts, free food, comps, voids, refunds, or other adjustments for yourself, friends, family, coworkers, or customers.",
      "Do not take another employee's delivery, cash, or tip opportunity outside the established rotation or management direction.",
      "Theft, intentional falsification of records, deliberate cash manipulation, or knowingly dishonest conduct may result in immediate termination and may be referred to law enforcement when appropriate.",
      "Tip practices must follow company policy and applicable law. Questions about a tip allocation should be raised with management rather than resolved by employees taking matters into their own hands.",
    ],
  },
  {
    title: "10. Workplace respect and conduct",
    bullets: [
      "Treat coworkers, customers, vendors, and managers with basic respect. Fighting, threats, intimidation, bullying, or deliberate disruption of the workplace are prohibited.",
      "Discrimination, unlawful harassment, and retaliation are prohibited. Employees should report concerns promptly to a manager or the owner and may bypass any person who is involved in the concern.",
      "Retaliation for making a good-faith complaint, reporting a safety or legal concern, participating in an investigation, or exercising a legally protected right is prohibited.",
      "Nothing in this handbook prevents employees from discussing wages, hours, schedules, working conditions, or other matters protected by law.",
    ],
  },
  {
    title: "11. Safety and emergencies",
    bullets: [
      "Use knives, slicers, fryers, ovens, hot surfaces, cleaning chemicals, ladders, and other equipment only as trained and with required guards and protective equipment in place.",
      "Do not bypass safety devices or take shortcuts that create an unreasonable risk of injury.",
      "Report injuries, burns, cuts, falls, near misses, unsafe equipment, gas or electrical concerns, and other hazards immediately, even when the injury appears minor.",
      "Keep exits, electrical panels, fire equipment, aisles, and walking surfaces clear. Address wet or greasy floors promptly and use warning signs when appropriate.",
      "In an emergency, protect people first, contact emergency services when necessary, and follow management or first-responder instructions.",
    ],
  },
  {
    title: "12. Alcohol, drugs, smoking, and impairment",
    bullets: [
      "Employees may not work while impaired by alcohol, illegal drugs, or any substance that makes them unable to perform their job safely.",
      "Illegal drug possession, use, or distribution at work is prohibited.",
      "Smoking and vaping are permitted only in locations and during times allowed by company policy and applicable law, and never in food-preparation or prohibited areas.",
      "Employees using lawful medication that may affect safe job performance should follow any applicable safety instructions and raise work-safety concerns with management when necessary.",
    ],
  },
  {
    title: "13. Appearance, hygiene, and readiness for work",
    bullets: [
      "Arrive in clean, work-appropriate clothing and footwear suitable for the assigned job and restaurant safety requirements.",
      "Follow required hair-restraint, handwashing, glove, jewelry, and personal-hygiene rules for food service.",
      "Bring required work items and be ready to begin at the scheduled start time rather than using the first part of the shift to get personally organized.",
    ],
  },
  {
    title: "14. Phones, recordings, confidential information, and social media",
    bullets: [
      "Personal phones should remain put away while actively working unless a manager authorizes a business or emergency use.",
      "Do not disclose customer addresses, phone numbers, payment information, employee private information, passwords, security information, or other confidential business records without authorization.",
      "Do not post private customer or employee information, security footage, payment information, or confidential company records on social media.",
      "This policy does not prohibit lawful discussions or communications about wages, hours, working conditions, workplace concerns, or other legally protected activity.",
    ],
  },
  {
    title: "15. Discipline, repeated violations, and employment status",
    paragraphs: [
      "Corner Deli tries to handle ordinary problems reasonably, but repeated violations, serious misconduct, safety violations, dishonesty, attendance failures, or refusal to follow lawful work instructions may result in discipline up to and including termination. Depending on the seriousness of the conduct, management may skip intermediate steps.",
      "Unless a written agreement signed by the owner states otherwise, employment is at will to the extent permitted by New York law. This handbook is not a contract guaranteeing employment for any specific period and does not waive any right provided by law.",
    ],
  },
];

export const CORNER_DELI_HANDBOOK_ACKNOWLEDGMENT =
  "I acknowledge that I received and reviewed the Corner Deli Employee Handbook, understand that I am expected to follow these policies, and understand that I should ask management when I am unsure how a policy applies. I understand that this acknowledgment is not an employment contract and does not waive any right provided by law.";

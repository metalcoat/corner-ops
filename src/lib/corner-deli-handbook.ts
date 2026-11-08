export type HandbookSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

// Sections 2 (call-outs), 18 and 19 (alcohol, smoking), and the driver pay wording in section 9 remain drafts awaiting Chris's review. When approved,
// drop "-draft" and the "(draft: owner review)" title notes. Any change to this file asks every employee to sign again.
export const CORNER_DELI_HANDBOOK_VERSION = "2026-11-08-draft";
export const CORNER_DELI_HANDBOOK_EFFECTIVE_DATE = "November 8, 2026";

export const CORNER_DELI_HANDBOOK_TITLE = "Corner Deli Employee Handbook";

export const CORNER_DELI_HANDBOOK_INTRO = [
  "This handbook explains the day-to-day standards expected of employees of Corner Deli (Mike's Corner Deli, LLC). The goal is simple: serve customers well, work safely, communicate with the team, protect food quality, handle money honestly, and keep the operation moving efficiently.",
  "No handbook can cover every situation. Management may make reasonable operational decisions as circumstances require, and policies may be updated when business needs or applicable law change. Employees will be asked to acknowledge material handbook revisions.",
];

export const CORNER_DELI_HANDBOOK_SECTIONS: HandbookSection[] = [
  {
    title: "1. Attendance, scheduling, and daily responsibility",
    bullets: [
      "Report to work on time and ready to begin working at the scheduled start time.",
      "Employees are expected to work at a safe, efficient pace, move with purpose, multitask when appropriate, answer phones, and help coworkers rather than waiting for a task to be assigned when work is obviously available.",
      "Management is here to explain the work and answer questions. Once you understand a task, you are responsible for doing it without daily reminders. Wiping tables, cleaning bathrooms, and keeping up with daily work are part of the job; do not leave obvious work for someone else.",
      "Schedule conflicts, lateness, transportation problems, and other foreseeable issues must be communicated to management as early as possible. Problems that are not communicated in advance place the burden on the rest of the team and may result in discipline. Call-outs follow section 2.",
      "Repeated lateness may result in discipline up to and including termination.",
      "During training, employees may be scheduled across different days and time periods so they can learn the operation. After training, management will generally try to maintain consistent schedules when business needs allow.",
      "Do not work off the clock, clock in or out for another employee, or ask another employee to do so. Report missed or incorrect punches promptly.",
    ],
  },
  {
    title: "2. Call-outs and finding coverage (draft: owner review)",
    paragraphs: [
      "We run with a small crew, so one missing person affects everyone working that day. Last-minute call-outs must be rare.",
    ],
    bullets: [
      "If you can't work a scheduled shift, text the manager at least 4 hours before your shift starts. A text is fine; the store may not be open yet to answer the phone.",
      "Right after you text, tap \"I need coverage\" on that shift in the Corner Deli app. It sends your shift to the whole team so a coworker can pick it up.",
      "You still have the shift until a manager approves a coworker taking it. If nobody covers it, the manager decides; don't assume you're off.",
      "If something comes up less than 4 hours before your shift, text the manager immediately and still post for coverage. Repeated late call-outs may result in discipline.",
      "No-call/no-show (missing a shift without texting the manager before it starts) means immediate termination, except in an extreme outside emergency (such as a hospital visit or an accident) that the owner reviews.",
      "Sick: if you're sick or need New York paid sick leave, text the manager as soon as you can. You don't have to find your own coverage to use sick leave, you don't have to say what the illness is, and you won't be disciplined for using sick leave you're entitled to. A doctor's note can only be asked for after 3 or more work days in a row.",
      "Planned time off goes through Time off in the app, before the schedule is posted.",
    ],
  },
  {
    title: "3. Appearance, hygiene, and readiness for work",
    bullets: [
      "Arrive in clean, work-appropriate clothing and footwear suitable for the assigned job and restaurant safety requirements.",
      "Follow required hair-restraint, handwashing, glove, jewelry, and personal-hygiene rules for food service.",
      "Bring required work items and be ready to begin at the scheduled start time rather than using the first part of the shift to get personally organized.",
    ],
  },
  {
    title: "4. Breaks, meal periods, and building coverage",
    bullets: [
      "Arrange breaks with the manager and tell your teammate before stepping away. Confirm who is covering the work; do not assume someone else knows you are leaving.",
      "At least one on-duty employee must remain INSIDE the building during breaks. The employee covering customers, phones, or the building stays on the clock. If coverage is not available, contact the manager to arrange it.",
      "Clock out for an unpaid meal period only when you are fully relieved of all work duties, and clock back in when it ends. You are free to leave during an unpaid meal period; another on-duty employee provides building coverage.",
      "Short rest breaks of 20 minutes or less are paid time. Stay clocked in for those breaks. Any other break that must be paid under applicable law remains paid.",
      "Management must schedule the meal periods required by New York law for the length and timing of your shift. A rush or a coverage problem does not cancel a required meal period.",
      "If a meal period is interrupted by work, clock back in and tell the manager so the time record and any affected meal period are corrected. Never answer phones, clean, or provide coverage off the clock.",
    ],
  },
  {
    title: "5. Customer service: the customer is always right (even when they are not)",
    bullets: [
      "Do not argue with a customer. Stay calm, clarify the problem, and make a reasonable effort to resolve it before transferring the customer to a manager.",
      "If a customer becomes threatening, discriminatory, harassing, or unsafe, employees are not required to accept the conduct. Step away and involve the manager on duty immediately.",
      "Be polite when asking a customer to repeat information you did not hear. A correct order is faster than remaking a wrong one.",
      "Answer phones promptly and professionally. Use caller ID when available and verify delivery addresses and callback numbers before completing a delivery order.",
    ],
  },
  {
    title: "6. Order taking and phone standards",
    bullets: [
      "Employees who take orders must learn the menu, including the normal sides and condiments that come with menu items.",
      "Do not read every optional modifier to the customer. Optional modifiers exist for customers who request a special order. Follow the normal ordering script and move to the next necessary question.",
      "For example, do not list salsa, jalapenos, buffalo sauce, and every other optional modifier for a chicken quesadilla unless the customer asks to customize it.",
      "For subs and similar items, follow the established script instead of listing every condiment and topping in the system.",
      "Use caller ID information as a tool, but still confirm information that matters to the order. Delivery addresses must be verified before the order is sent to the kitchen or driver.",
      "For an unusual, expensive, or potentially costly order, or if there is any confusion about what the customer wants or what we entered, read the ENTIRE order back at the end of the call and get the customer's confirmation before moving forward. Include quantities, sizes, changes, and pickup or delivery details.",
      "If the customer changes even one thing during confirmation, update the order, reread the whole order, and get confirmation again. Repeat until the customer confirms the complete order as entered. Do not guess or rely on an earlier confirmation.",
      "A few extra seconds confirming an order is better than spending 10 to 30 minutes or more fixing a mistake. Politely ask again whenever something is unclear.",
    ],
  },
  {
    title: "7. Order mistakes, owner notification, and corrected slips",
    paragraphs: [
      "The owner must be told about every order mistake promptly. Reporting will also be required in the new system; the reporting expectation applies now.",
    ],
    bullets: [
      "Open the original order and compare what the customer confirmed, what was entered, and what was made. Establish whether the order was taken incorrectly or prepared incorrectly. If the cause is unclear, record that and ask for help rather than guessing.",
      "Make the necessary correction and REPRINT THE CORRECTION. The printed slip must clearly show the correct items and instructions. A verbal explanation by itself is not enough.",
      "Give the corrected slip to the person making the food and clearly identify what needs to be remade. Mark the affected original slip as superseded so the same items are not made twice by mistake; keep the correction linked to the original order.",
      "Record the order number, what went wrong, the correction, any food wasted or remade, and who was notified. Use the record designated by management; until a shared record is available, send these details to the owner with the mistake report.",
      "Refunds, discounts, voids, and other adjustments still require the appropriate authorization. Reporting or correcting a mistake is not permission to give away food or change a charge on your own.",
    ],
  },
  {
    title: "8. Cooks and kitchen production",
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
    title: "9. Delivery drivers",
    bullets: [
      "Pay for driving (draft: owner review): driving hours are paid at the driver (tipped) rate shown on your New York pay notice, plus your delivery tips. Corner Deli takes the New York food service tip credit for those hours. If your driver wage plus delivery tips for a week come to less than the full minimum wage for your driving hours, Corner Deli pays the difference.",
      "Overtime (draft: owner review): hours over 40 in a week are counted in the order you work them. Each overtime hour is paid at 1.5 times the rate for the job you're doing at that time: in-store at 1.5 times your regular rate, driving at the driving overtime rate on your pay notice ($18.70 in 2026 for a $10.70 driver rate). You agree to this when you sign your pay notice.",
      "Time spent on non-delivery work (prep, dishes, the register) is paid at your regular rate. If you're doing that kind of work for more than a short stretch, tell the manager so the time is recorded correctly.",
      "The rear delivery cash drawer is set to $0 at the end of each night. Each delivery money bag is normally set to $60 at the beginning of the shift.",
      "Count the delivery bag before beginning the shift and report any discrepancy immediately so the starting balance is documented.",
      "The target $60 bag mix is $10 in tens (1 x $10), $25 in fives (5 x $5), $23 in ones (23 x $1), and $2 in quarters (8 x $0.25), subject to available change.",
      "Each delivery order must be properly cashed out and the drawer/bag totals must reconcile at the end of the shift. Cash shortages or overages must be reported to management. The company will not make unauthorized deductions from wages or tips for shortages; repeated or unexplained mismatches may still result in investigation and discipline.",
      "Drivers are part of a team. During busy periods, management may group deliveries by location and rotate grouped runs among drivers.",
      "Drivers may not dis-group deliveries, skip the rotation, take another driver's turn, or manipulate routes in order to maximize personal tips or select only preferred orders.",
      "When management groups deliveries, credit-card tips may be divided among the assigned drivers under the company's tip procedures and applicable law.",
      "For delivery orders requiring items from the front of the store, obtain those items first, bring them to the rear for final bagging, and only then move the completed order to the delivery vehicle.",
      "Drivers must maintain any license, registration, and insurance required for their driving duties, obey traffic laws, wear seat belts, and never use a handheld phone while driving. Accidents, tickets affecting driving privileges, or vehicle safety problems must be reported promptly.",
    ],
  },
  {
    title: "10. Food safety, sanitation, and illness reporting",
    bullets: [
      "Follow all required handwashing, glove, utensil, temperature, storage, labeling, date-marking, and cross-contamination procedures.",
      "Clean as you go. Keep prep surfaces, equipment, floors, coolers, freezers, sinks, bathrooms, dining areas, and workstations in sanitary condition throughout the shift, not merely at closing.",
      "Report spills, broken equipment, unsafe temperatures, pest activity, contamination concerns, and other food-safety problems immediately.",
      "Employees must report symptoms or conditions that food-safety rules require to be reported. Management will handle work restrictions or exclusions as required by law and public-health rules.",
      "Never serve food you reasonably believe is contaminated, spoiled, improperly held, or otherwise unsafe. Stop and ask a manager.",
    ],
  },
  {
    title: "11. Daily cleaning, closing, and late deliveries",
    bullets: [
      "Clean throughout the shift and complete the daily cleaning work without constant reminders. Wipe tables as needed, check the bathrooms during the day, and clean the toilets and bathrooms every day. A toilet must not go a week without cleaning.",
      "Management will provide a daily cleaning checklist with a named person responsible for each task. Until it is posted, agree with the manager and your teammate on who is doing each task. Mark a task complete only after doing it, and report anything unfinished or any supplies or equipment needed.",
      "Two employees will be scheduled until 30 minutes after closing every night. Follow the posted schedule, divide the closing work, and check together that the required tasks are complete.",
      "For a delivery received in the last 30 minutes before closing, finish the necessary cleaning before sending the delivery out whenever possible. Coordinate with your teammate so the building remains covered.",
      "Do not hold a delivery for cleaning if doing so would compromise food safety or quality or miss the delivery time quoted to the customer. Tell the manager when cleaning and delivery commitments conflict, and update the customer if the promised time changes.",
      "Closing work includes the front floor, tables, grill, bathrooms, emptying all trash cans in the front, bathrooms, and kitchens, and emptying the designated grease traps or grease collection containers using the trained procedure. Ask which equipment and procedure apply if unsure; never handle hot grease or unfamiliar equipment without training.",
      "The closing checklist is not permission to work off the clock. If work will run beyond the scheduled 30 minutes, tell the manager and record all time actually worked.",
    ],
  },
  {
    title: "12. Inventory, portions, spills, and waste",
    paragraphs: [
      "Management is already tracking inventory shortages and will track product use more closely, down to the ounce for ingredients measured by weight. All product used, discarded, spilled, wasted, or taken as an authorized employee meal must be accounted for.",
    ],
    bullets: [
      "Follow the standard recipe and portion for every item. Use the appropriate scale or measuring tool instead of free-pouring or guessing. Record packaged products by unit and ingredients in the specified measurement unit.",
      "Promptly record spills, discarded food, spoilage, preparation mistakes, remakes, and other waste. Include the item, quantity and unit, reason, date and time, employee, and related order number when there is one.",
      "Address an immediate safety or sanitation problem first, then document the loss. If the quantity cannot be measured, identify it as an estimate and tell the manager rather than making up an exact amount.",
      "Report inventory discrepancies to the owner. A shortage needs investigation; do not assume its cause or hide it by changing a count.",
      "When employee meals resume, every authorized meal and its ingredients must be recorded through the employee-menu process. Mistakes and waste do not become unrecorded free employee food.",
    ],
  },
  {
    title: "13. Employee meals, discounts, custom items, and drinks",
    paragraphs: [
      "Employee meals are suspended until the new POS system and separate employee menu are launched by the owner. This replaces the previous free-meal benefit, including the six-hour eligibility rule. The meal benefit is separate from any meal period required by law.",
    ],
    bullets: [
      "When the new program launches, use the separate employee menu and its approved items, portions, and prices. Some items outside that menu will have an employee discount and some will have no discount. Only the owner-approved pricing applies; do not create your own discount.",
      "If you currently make a custom item that you want included on the new employee menu, tell the owner. The owner will decide how to account for the ingredients, portions, and price before it is added.",
      "Once the employee meal program launches, authorized employee meals must be prepared by the cooks, follow the approved portions, and be recorded. Delivery drivers may not prepare their own employee meals. Ask permission before any employee meal is prepared or taken.",
      "Eat during an approved break or other off-duty time, not while performing active work. The paid or unpaid status of a break follows section 4.",
      "Do not take an order mistake, leftover, or waste item as a free employee meal. Report it and follow the owner's direction; the former meal-mistake allowance does not continue during the suspension.",
      "Complimentary store drinks were discontinued and remain excluded from the employee benefit.",
      "The planned drink program at launch is cost plus tax and deposit, rounded to the nearest $0.25. Around $1.50 is an estimate, not a fixed price for every drink. The owner will confirm the eligible drinks and prices when the program opens.",
    ],
  },
  {
    title: "14. Company card purchases and receipts",
    bullets: [
      "Company card purchases are limited to $30 per day. This is a daily limit, not a separate allowance for each employee or each purchase.",
      "Message or call the owner as soon as possible about any purchase outside normal business purchases. Contact the owner if a needed purchase would exceed the daily limit.",
      "Check the day's spending with the manager or the shared daily spending record before using the card. Keep the itemized receipt and record the date, amount, business purpose, and person making the purchase. Until management provides a shared record, send those details and the receipt to the owner so the team can check the daily total.",
    ],
  },
  {
    title: "15. Cash, discounts, comps, voids, tips, and honesty",
    bullets: [
      "Handle company money and customer payments accurately. Do not borrow from drawers, bags, deposits, or company funds.",
      "Do not create unauthorized discounts, free food, comps, voids, refunds, or other adjustments for yourself, friends, family, coworkers, or customers.",
      "Do not take another employee's delivery, cash, or tip opportunity outside the established rotation or management direction.",
      "Theft, intentional falsification of records, deliberate cash manipulation, or knowingly dishonest conduct may result in immediate termination and may be referred to law enforcement when appropriate.",
      "Tip practices must follow company policy and applicable law. Questions about a tip allocation should be raised with management rather than resolved by employees taking matters into their own hands.",
    ],
  },
  {
    title: "16. Workplace respect and conduct",
    bullets: [
      "Treat coworkers, customers, vendors, and managers with basic respect. Fighting, threats, intimidation, bullying, or deliberate disruption of the workplace are prohibited.",
      "Discrimination, unlawful harassment, and retaliation are prohibited. Employees should report concerns promptly to a manager or the owner and may bypass any person who is involved in the concern.",
      "Retaliation for making a good-faith complaint, reporting a safety or legal concern, participating in an investigation, or exercising a legally protected right is prohibited.",
      "Nothing in this handbook prevents employees from discussing wages, hours, schedules, working conditions, or other matters protected by law.",
    ],
  },
  {
    title: "17. Safety and emergencies",
    bullets: [
      "Use knives, slicers, fryers, ovens, hot surfaces, cleaning chemicals, ladders, and other equipment only as trained and with required guards and protective equipment in place.",
      "Do not bypass safety devices or take shortcuts that create an unreasonable risk of injury.",
      "Report injuries, burns, cuts, falls, near misses, unsafe equipment, gas or electrical concerns, and other hazards immediately, even when the injury appears minor.",
      "Keep exits, electrical panels, fire equipment, aisles, and walking surfaces clear. Address wet or greasy floors promptly and use warning signs when appropriate.",
      "In an emergency, protect people first, contact emergency services when necessary, and follow management or first-responder instructions.",
    ],
  },
  {
    title: "18. Alcohol and drugs: zero tolerance (draft: owner review)",
    paragraphs: [
      "Corner Deli has zero tolerance for alcohol at work. There are no warnings and no second chances under this policy.",
    ],
    bullets: [
      "No drinking alcohol, having alcohol, or being under the influence of alcohol while on shift, anywhere on Corner Deli premises (inside, out front, the back lot, storage and coolers), or in the company vehicle.",
      "The slightest hint of alcohol is enough. Smelling of alcohol, an open container in your work area, belongings or the company vehicle, or appearing impaired means immediate termination.",
      "\"Only one drink\" or \"it was last night\" is not an exception. Come to work completely free of alcohol.",
      "Using, having, selling or being impaired by illegal drugs, or being impaired by cannabis or any other substance, at work, on the premises or in the company vehicle is also grounds for immediate termination.",
      "A manager who believes an employee may be impaired will remove them from work right away and will not let them drive a company vehicle or their own vehicle on a delivery.",
      "If you take a lawful medication that could affect your ability to work safely or drive, tell a manager before your shift. You do not have to say what the medication is.",
    ],
  },
  {
    title: "19. No smoking or vaping (draft: owner review)",
    bullets: [
      "No smoking or vaping of any kind (cigarettes, cigars, e-cigarettes and vapes, or cannabis) inside the building, out front of the store, or in the company vehicle. This applies at all times: on shift, on breaks and off the clock.",
      "\"Out front\" means the front entrance, the sidewalk and the front parking area: anywhere customers see or walk through.",
      "If you smoke or vape on a break, go only where a manager says it is allowed, away from doors, and wash your hands before you handle food again.",
      "Violations will result in discipline up to and including termination.",
    ],
  },
  {
    title: "20. Phones, recordings, confidential information, and social media",
    bullets: [
      "Personal phones should remain put away while actively working unless a manager authorizes a business or emergency use.",
      "Do not disclose customer addresses, phone numbers, payment information, employee private information, passwords, security information, or other confidential business records without authorization.",
      "Do not post private customer or employee information, security footage, payment information, or confidential company records on social media.",
      "This policy does not prohibit lawful discussions or communications about wages, hours, working conditions, workplace concerns, or other legally protected activity.",
    ],
  },
  {
    title: "21. Discipline, repeated violations, and employment status",
    paragraphs: [
      "Corner Deli tries to handle ordinary problems reasonably, but repeated violations, serious misconduct, safety violations, dishonesty, attendance failures, or refusal to follow lawful work instructions may result in discipline up to and including termination. Depending on the seriousness of the conduct, management may skip intermediate steps.",
      "Unless a written agreement signed by the owner states otherwise, employment is at will to the extent permitted by New York law. This handbook is not a contract guaranteeing employment for any specific period and does not waive any right provided by law.",
    ],
  },
];

export const CORNER_DELI_HANDBOOK_ACKNOWLEDGMENT =
  "I acknowledge that I received and reviewed the Corner Deli Employee Handbook, understand that I am expected to follow these policies, and understand that I should ask management when I am unsure how a policy applies. I understand that this acknowledgment is not an employment contract and does not waive any right provided by law.";

export type DietaryType = "veg" | "non-veg";

export type MenuChoice = { id: string; name: string; priceDeltaPaise?: number; pricePaise?: number };

export type MenuItem = {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  pricePaise: number;
  imageUrl?: string;
  dietaryType: DietaryType;
  isActive: boolean;
  isAvailable: boolean;
  variants?: MenuChoice[];
  addOns?: MenuChoice[];
  variantRequired?: boolean;
  sortOrder?: number;
};

export type MenuCategory = { id: string; name: string; isActive: boolean; sortOrder: number };

export type TableContext = {
  shopId: string;
  restaurantId: string;
  restaurantName: string;
  tableNumber: string;
  taxRateBps: number;
  serviceFeePaise: number;
  payAtRestaurantEnabled: boolean;
  upiEnabled: boolean;
  upiId: string;
  upiPayeeName: string;
  isAcceptingOrders: boolean;
};

export type TableRecord = {
  id: string;
  tableNumber: string;
  isActive: boolean;
  qrToken: string;
  createdAt?: number;
};

export type OrderStatus = "queued" | "accepted" | "preparing" | "ready" | "served" | "cancelled";

export type OrderItem = {
  name: string;
  quantity: number;
  lineTotalPaise: number;
  specialInstructions?: string;
  selections?: string[];
};

export type AdminOrder = {
  id: string;
  ticketId: string;
  tableNumberSnapshot: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  items: OrderItem[];
  subtotalPaise: number;
  taxPaise: number;
  serviceFeePaise: number;
  totalAmountPaise: number;
  paymentStatus?: "mock_paid" | "pending" | "paid" | "failed";
  paymentProvider?: "mock" | "manual" | "razorpay" | "stripe";
  paymentTiming?: "prepaid" | "pay_after_serve";
  paymentMethod?: "mock" | "pay_after_serve" | "cash" | "upi" | "card";
  whatsappBillOptIn?: boolean;
  whatsappBillStatus?: "sending" | "sent" | "failed";
  whatsappMessageId?: string;
  whatsappBillSentAt?: { toDate: () => Date; toMillis: () => number };
  whatsappBillSendStartedAt?: { toDate: () => Date; toMillis: () => number };
  status: OrderStatus;
  assignedStaffUid?: string | null;
  estimatedMinutes: number | null;
  customerServedResponse?: { response: "yes" | "no"; details?: string; createdAt?: { toDate: () => Date; toMillis: () => number } };
  serviceIssueResolvedAt?: { toDate: () => Date; toMillis: () => number };
  statusEvents?: { status: OrderStatus; at?: { toDate: () => Date; toMillis: () => number } }[];
  expectedReadyAt?: { toDate: () => Date } | null;
  createdAt?: { toDate: () => Date };
};

export type WaiterOrder = {
  id: string;
  ticketId: string;
  tableNumberSnapshot: string;
  items: Pick<OrderItem, "name" | "quantity" | "specialInstructions" | "selections">[];
  status: OrderStatus;
  estimatedMinutes: number | null;
  expectedReadyAt?: { toDate: () => Date } | null;
  createdAt?: { toDate: () => Date };
};

export type PublicTracking = {
  ticketId: string;
  tableNumber: string;
  status: OrderStatus;
  paymentTiming?: "prepaid" | "pay_after_serve";
  paymentStatus?: "mock_paid" | "pending" | "paid" | "failed";
  paymentMethod?: "mock" | "pay_after_serve" | "cash" | "upi" | "card";
  items?: Pick<OrderItem, "name" | "quantity" | "lineTotalPaise" | "selections">[];
  subtotalPaise?: number;
  taxPaise?: number;
  serviceFeePaise?: number;
  totalAmountPaise?: number;
  estimatedMinutes: number | null;
  expectedReadyAtMs: number | null;
  statusEvents: { status: OrderStatus; atMs: number | null }[];
  customerServedResponse?: { response: "yes" | "no"; details?: string; atMs: number | null };
};

export type StaffRole = "owner" | "manager" | "kitchen" | "waiter";

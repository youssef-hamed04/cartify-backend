import { body, param, validationResult } from 'express-validator';
import { AppError } from '../utils/error.js';

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => e.msg);
    return next(new AppError(messages[0], 400, errors.array()));
  }
  next();
};

// ── Auth ──────────────────────────────────────────────────────────────────────
export const authRules = [
  body('email').trim().toLowerCase().isEmail().withMessage('Please provide a valid email address'),
];

export const updateUserRules = [
  body('firstName').optional().trim().isLength({ min: 2 }).withMessage('First name must be at least 2 characters'),
  body('lastName').optional().trim().isLength({ min: 2 }).withMessage('Last name must be at least 2 characters'),
  body('phone').optional().matches(/^(010|011|012|015)[0-9]{8}$/).withMessage('Invalid Egyptian phone number'),
  body('governorate').optional().trim().notEmpty().withMessage('Governorate cannot be empty'),
];

// ── Product ───────────────────────────────────────────────────────────────────
export const productRules = [
  body('name').trim().notEmpty().withMessage('Product name is required'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('description').trim().notEmpty().withMessage('Description is required'),
  body('category').trim().notEmpty().withMessage('Category is required'),
  body('brand').optional().trim(),
  body('discount').optional().isFloat({ min: 0, max: 100 }).withMessage('Discount must be 0-100'),
];

// ── Category ──────────────────────────────────────────────────────────────────
export const categoryRules = [
  body('name').trim().notEmpty().withMessage('Category name is required'),
  body('description').optional().trim(),
];

// ── Cart ──────────────────────────────────────────────────────────────────────
export const addToCartRules = [
  body('productId').isMongoId().withMessage('Invalid product ID'),
  body('color').trim().notEmpty().withMessage('Color is required'),
  body('quantity').optional().isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
];

export const cartItemRules = [
  body('productId').isMongoId().withMessage('Invalid product ID'),
  body('color').trim().notEmpty().withMessage('Color is required'),
];

// ── Wishlist ──────────────────────────────────────────────────────────────────
export const wishlistRules = [
  body('productId').isMongoId().withMessage('Invalid product ID'),
];

// ── Order ─────────────────────────────────────────────────────────────────────
const EGYPTIAN_PHONE = /^(010|011|012|015)[0-9]{8}$/;
const EMAIL_REGEX    = /^[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.(com)$/;
const ORDER_STATUSES = ['placed', 'confirmed', 'shipping', 'delivered', 'cancelled', 'refunded'];

export const createOrderRules = [
  body('email').matches(EMAIL_REGEX).withMessage('Invalid email address'),
  body('firstName').trim().isLength({ min: 2 }).withMessage('First name must be at least 2 characters'),
  body('lastName').trim().isLength({ min: 2 }).withMessage('Last name must be at least 2 characters'),
  body('address').trim().isLength({ min: 5 }).withMessage('Address is too short'),
  body('phone').matches(EGYPTIAN_PHONE).withMessage('Invalid Egyptian phone number'),
  body('city').trim().isLength({ min: 2 }).withMessage('City is required'),
  body('governorate').trim().isLength({ min: 2 }).withMessage('Governorate is required'),
  body('paymentMethod').optional().isIn(['cash', 'credit_card', 'instaPay', 'vodafoneCash']).withMessage('Invalid payment method'),
  body('notes').optional().trim().isLength({ max: 500 }).withMessage('Notes too long'),
];

export const updateOrderRules = [
  body('status').optional().isIn(ORDER_STATUSES).withMessage(`Status must be one of: ${ORDER_STATUSES.join(', ')}`),
  body('email').optional().matches(EMAIL_REGEX).withMessage('Invalid email address'),
  body('phone').optional().matches(EGYPTIAN_PHONE).withMessage('Invalid Egyptian phone number'),
  body('firstName').optional().trim().isLength({ min: 2 }).withMessage('First name too short'),
  body('lastName').optional().trim().isLength({ min: 2 }).withMessage('Last name too short'),
  body('address').optional().trim().isLength({ min: 5 }).withMessage('Address too short'),
  body('trackingNumber').optional().trim(),
  body('notes').optional().trim().isLength({ max: 500 }).withMessage('Notes too long'),
];

// ── Review ────────────────────────────────────────────────────────────────────
export const createReviewRules = [
  body('productId').isMongoId().withMessage('Invalid product ID'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('title').optional().trim().isLength({ max: 100 }).withMessage('Title too long'),
  body('body').optional().trim().isLength({ max: 2000 }).withMessage('Review body too long'),
  body('orderId').optional().isMongoId().withMessage('Invalid order ID'),
];

export const updateReviewRules = [
  body('rating').optional().isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('title').optional().trim().isLength({ max: 100 }).withMessage('Title too long'),
  body('body').optional().trim().isLength({ max: 2000 }).withMessage('Review body too long'),
];

// ── Return Request ────────────────────────────────────────────────────────────
const RETURN_REASONS = ['defective', 'wrong_size', 'changed_mind', 'wrong_item', 'other'];

export const createReturnRules = [
  body('orderId').optional().isMongoId().withMessage('Invalid order ID'),
  body('reason')
    .isIn(RETURN_REASONS)
    .withMessage(`Reason must be one of: ${RETURN_REASONS.join(', ')}`),
  body('notes').optional().trim().isLength({ max: 1000 }).withMessage('Notes too long'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.productId').isMongoId().withMessage('Invalid product ID in items'),
  body('items.*.name').trim().notEmpty().withMessage('Item name is required'),
  body('items.*.color').trim().notEmpty().withMessage('Item color is required'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Item quantity must be at least 1'),
];

// ── Param helpers ─────────────────────────────────────────────────────────────
export const mongoIdParam = (field = 'id') => [
  param(field).isMongoId().withMessage(`Invalid ${field}`),
];

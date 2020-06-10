/* eslint-disable no-console */
/* eslint-disable no-underscore-dangle */
const crypto = require('crypto');
const fetch = require('node-fetch');
const ErrorResponse = require('../helpers/errorResponse');
const asyncHandler = require('../middlewares/async');
const sendEmail = require('../helpers/sendEmail');
const User = require('../models/User');
const { generateCustomerId } = require('../helpers/generateCustomer');
// Get token from model, create cookie and send response


const sendTokenResponse = (user, statusCode, res) => {
  // Create token
  const token = user.getSignedJwtToken();

  const options = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000
    ),
    httpOnly: true
  };

  if (process.env.NODE_ENV === 'production') {
    options.secure = true;
  }

  res
    .status(statusCode)
    .cookie('token', token, options)
    .json({
      success: true,
      token
    });
};

// @desc      Register user
// @route     POST /api/v1/auth/register
// @access    Public
exports.register = asyncHandler(async (req, res, next) => {
  const {
    firstName, lastName, email, password, role, phone
  } = req.body;

  // Create user
  const user = await User.create({
    firstName,
    lastName,
    email,
    password,
    role,
    phone
  });
  generateCustomerId(user.email, user);
  sendTokenResponse(user, 200, res);
});

// @desc      Login user
// @route     POST /api/v1/auth/login
// @access    Public
exports.login = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;

  // Validate emil & password
  if (!email || !password) {
    return next(new ErrorResponse('Please provide an email and password', 400));
  }

  // Check for user
  const user = await User.findOne({ email }).select('+password');

  if (!user) {
    return next(new ErrorResponse('Invalid credentials', 401));
  }

  // Check if password matches
  const isMatch = await user.matchPassword(password);

  if (!isMatch) {
    return next(new ErrorResponse('Invalid credentials', 401));
  }

  sendTokenResponse(user, 200, res);
});

// @desc      Log user out / clear cookie
// @route     GET /api/v1/auth/logout
// @access    Private
exports.logout = asyncHandler(async (req, res) => {
  res.cookie('token', 'none', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true
  });

  res.status(200).json({
    success: true,
    data: {}
  });
});

// @desc      Get current logged in user
// @route     POST /api/v1/auth/me
// @access    Private
exports.getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);

  res.status(200).json({
    success: true,
    data: user
  });
});

// @desc      Update user details
// @route     PUT /api/v1/auth/updatedetails
// @access    Private
exports.updateDetails = asyncHandler(async (req, res) => {
  const fieldsToUpdate = {
    firstName: req.body.firstName || req.user.firstName,
    lastName: req.body.lastName || req.user.lastName,
    email: req.body.email || req.user.email
  };

  const user = await User.findByIdAndUpdate(req.user.id, fieldsToUpdate, {
    new: true,
    runValidators: true
  });

  res.status(200).json({
    success: true,
    data: user
  });
});

// @desc      Update password
// @route     PUT /api/v1/auth/updatepassword
// @access    Private
exports.updatePassword = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id).select('+password');

  // Check current password
  if (!(await user.matchPassword(req.body.currentPassword))) {
    return next(new ErrorResponse('Password is incorrect', 401));
  }

  user.password = req.body.newPassword;
  await user.save();

  sendTokenResponse(user, 200, res);
});

// @desc      Forgot password
// @route     POST /api/v1/auth/forgotpassword
// @access    Public
exports.forgotPassword = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email });

  if (!user) {
    return next(new ErrorResponse('There is no user with that email', 404));
  }

  // Get reset token
  const resetToken = user.getResetPasswordToken();

  await user.save({ validateBeforeSave: false });

  // Create reset url
  const resetUrl = `${req.protocol}://${req.get(
    'host'
  )}/api/v1/auth/resetpassword/${resetToken}`;

  const message = `You are receiving this email because you (or someone else) has requested the reset of a password. Please make a PUT request to: \n\n ${resetUrl}`;

  try {
    await sendEmail({
      email: user.email,
      subject: 'Password reset token',
      message
    });

    res.status(200).json({ success: true, data: 'Email sent' });
  } catch (err) {
    console.log(err);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;

    await user.save({ validateBeforeSave: false });

    return next(new ErrorResponse('Email could not be sent', 500));
  }

  res.status(200).json({
    success: true,
    data: user
  });
});

// @desc      Reset password
// @route     PUT /api/v1/auth/resetpassword/:resettoken
// @access    Public
exports.resetPassword = asyncHandler(async (req, res, next) => {
  // Get hashed token
  const resetPasswordToken = crypto
    .createHash('sha256')
    .update(req.params.resettoken)
    .digest('hex');

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() }
  });

  if (!user) {
    return next(new ErrorResponse('Invalid token', 400));
  }

  // Set new password
  user.password = req.body.password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();

  sendTokenResponse(user, 200, res);
});

exports.sendBvnVerification = asyncHandler(async (req, res, next) => {
  try {
    await fetch(`https://api.paystack.co/bank/resolve_bvn/${req.body.bvn}`, {
      method: 'get',
      headers: {
        authorization: process.env.PAYSTACK_API_KEY
      }
    }).then((res) => res.json()).then(async (response) => {
      // TODO: Send BVNToken to response.data.mobile
      if (response.status == 'false') {
        return next(new ErrorResponse('Enter a valid BVN Number', 400));
      }
      const user = await User.findById(req.user._id);
      user.BvnToken = 1234;
      user.BvnTokenExpire = Date.now() + 10 * 60 * 1000;
      user.save();
      const data = {
        firstName: response.data.first_name,
        lastName: response.data.last_name,
        mobile: response.data.mobile
      };
      res.status(200).json({
        success: true,
        data
      });
    });
  } catch (e) {
    console.log(e.message);
  }
});
exports.verifyBvn = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (Date.now() > user.BvnTokenExpire) {
    return res.status(400).json({
      status: 'failed',
      message: 'Bvn token expired'
    });
  }
  if (req.body.bvnCode == user.BvnToken) {
    user.isverifed = true;
    user.save();
    return res.status(200).json({
      status: 'success',
      message: 'User is verified'
    });
  }
  return res.status(401).json({
    status: 'failed',
    message: 'invalid Token'
  });
});

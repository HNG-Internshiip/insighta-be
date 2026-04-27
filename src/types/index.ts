export type Gender    = "male" | "female";
export type AgeGroup  = "child" | "teenager" | "adult" | "senior";
export type SortField = "age" | "created_at" | "gender_probability";
export type SortOrder = "ASC" | "DESC";
export type Role      = "admin" | "analyst";

export interface Profile {
  id:                  string;
  name:                string;
  gender:              Gender;
  gender_probability:  number;
  age:                 number;
  age_group:           AgeGroup;
  country_id:          string;
  country_name:        string;
  country_probability: number;
  created_at:          string;
}

export interface ProfileFilters {
  gender?:                  Gender;
  age_group?:               AgeGroup;
  country_id?:              string;
  min_age?:                 number;
  max_age?:                 number;
  min_gender_probability?:  number;
  min_country_probability?: number;
}

export interface Pagination {
  page:   number;
  limit:  number;
  offset: number;
}

export interface User {
  id:            string;
  github_id:     string;
  username:      string;
  email:         string | null;
  avatar_url:    string | null;
  role:          Role;
  is_active:     boolean;
  last_login_at: string | null;
  created_at:    string;
}

export interface TokenPayload {
  sub:      string;   // user id
  username: string;
  role:     Role;
  type:     "access" | "refresh";
}

declare global {
  namespace Express {
    interface Request {
      filters?:    ProfileFilters;
      sortBy?:     SortField;
      sortOrder?:  SortOrder;
      pagination?: Pagination;
      rawQuery?:   string;
      user?:       User;
    }
  }
}